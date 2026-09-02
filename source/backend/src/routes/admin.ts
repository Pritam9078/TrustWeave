import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import { validate } from "./_helpers.js";
import { requireActor, requireHuman } from "../auth/middleware.js";
import * as identityService from "../services/identityService.js";
import * as orgService from "../services/orgService.js";
import * as policyService from "../services/policyService.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";
import { CAPABILITIES } from "../authorization/capabilities.js";
import { notFound, badRequest } from "../core/errors.js";
import { newTraceId } from "../core/ids.js";
import { one, many } from "../db/client.js";

/**
 * Identity & Access, Roles, Capabilities, Scopes, Policies, Organization, Security.
 *
 * Every mutating handler calls `authz.enforce` FIRST. There is no path in this file
 * where a service is touched before the authorization engine has returned ALLOW.
 */
export async function adminRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------- identities */

  app.get("/api/identities", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "IDENTITY_READ", resource: { type: "IDENTITY", query: true }, ip: req.ip });
    const q = req.query as any;

    // Row-level visibility, using the same scope machinery as assets rather than an
    // all-or-nothing gate. An access administrator (someone who can create identities or
    // assign roles) sees the whole directory; everyone else sees only the members whose
    // department falls inside their own assigned scopes. A plain User therefore sees
    // their own team, never the whole organization.
    const isAccessAdmin = actor.capabilities.has("IDENTITY_CREATE") || actor.capabilities.has("ROLE_ASSIGN");
    const rows = await identityService.listIdentities(actor.organizationId, q);
    const visible = [];
    if (isAccessAdmin) {
      visible.push(...rows);
    } else {
      for (const row of rows) {
        if (row.id === actor.identityId) { visible.push(row); continue; }
        const membership = await identityService.getMembership(row.id, actor.organizationId);
        if ((await authz.check({
          actor, action: "IDENTITY_READ",
          resource: { type: "IDENTITY", id: row.id, organizationId: actor.organizationId, departmentId: membership?.department_id ?? null },
        })).decision !== "DENY") {
          visible.push(row);
        }
      }
    }

    return {
      identities: visible.map(identityService.toApiIdentity),
      scopeFiltered: !isAccessAdmin,
      hiddenByScope: rows.length - visible.length,
    };
  });

  app.get("/api/identities/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "IDENTITY_READ", resource: { type: "IDENTITY", id }, ip: req.ip });
    const identity = await identityService.getIdentity(actor.organizationId, id);
    if (!identity) throw notFound("Identity not found.");
    const perms = await identityService.effectivePermissions(id, actor.organizationId);
    const membership = await identityService.getMembership(id, actor.organizationId);
    return {
      identity: identityService.toApiIdentity(identity),
      membership: membership ? { id: membership.id, departmentId: membership.department_id, status: membership.status } : null,
      effectivePermissions: perms,
      recentActivity: (await audit.query({ organizationId: actor.organizationId, actorId: id, limit: 25 })).events.map(audit.toApi),
    };
  });

  app.post("/api/identities", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createIdentity, req.body);
    const enforcement = await authz.enforce({
      actor, action: "IDENTITY_CREATE", resource: { type: "IDENTITY" }, ip: req.ip,
      payload: { displayName: body.displayName, kind: body.kind },
    });

    const { identity, privateKey } = await identityService.createIdentity({
      organizationId: actor.organizationId,
      displayName: body.displayName, email: body.email?.toLowerCase() ?? null,
      kind: body.kind, did: body.did, departmentId: body.departmentId ?? null,
      password: body.password, status: "ACTIVE",
    });

    const membership = (await identityService.getMembership(identity.id, actor.organizationId))!;
    for (const roleId of body.roleIds) await identityService.assignRole(membership.id, roleId, actor.identityId);
    for (const scopeId of body.scopeIds) await identityService.assignScopeToMembership(membership.id, scopeId);

    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "IDENTITY_CREATED", resourceType: "IDENTITY", resourceId: identity.id,
      decision: "EXECUTED", payload: { did: identity.did, roleIds: body.roleIds, scopeIds: body.scopeIds },
    });

    return reply.code(201).send({
      identity: identityService.toApiIdentity(identity),
      // Shown exactly once. There is no column storing it, so it cannot be recovered.
      privateKey,
      privateKeyNotice: privateKey ? "This private key is shown once and is not stored anywhere. Save it now — it is required for DID sign-in." : null,
    });
  });

  app.patch("/api/identities/:id/status", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.identityStatus, req.body);
    const action = body.status === "REVOKED" ? "IDENTITY_REVOKE" : body.status === "SUSPENDED" ? "IDENTITY_SUSPEND" : "IDENTITY_UPDATE";

    // Self-lockout guard: an admin suspending their own identity would immediately lose
    // the ability to undo it. Cheap to prevent, expensive to recover from.
    if (id === actor.identityId && body.status !== "ACTIVE") {
      throw badRequest("SELF_LOCKOUT", "You cannot suspend or revoke your own identity. Ask another administrator.");
    }

    const enforcement = await authz.enforce({ actor, action, resource: { type: "IDENTITY", id }, ip: req.ip, payload: { status: body.status, reason: body.reason } });
    const updated = await identityService.setIdentityStatus(actor.organizationId, id, body.status);

    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: `IDENTITY_${body.status}`, resourceType: "IDENTITY", resourceId: id,
      decision: "EXECUTED", payload: { reason: body.reason, sessionsRevoked: body.status !== "ACTIVE" },
    });
    return { identity: identityService.toApiIdentity(updated) };
  });

  app.post("/api/identities/:id/roles", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const { roleId } = req.body as { roleId: string };
    if (!roleId) throw badRequest("ROLE_REQUIRED", "roleId is required.");
    const enforcement = await authz.enforce({ actor, action: "ROLE_ASSIGN", resource: { type: "MEMBERSHIP", id }, ip: req.ip, payload: { roleId } });

    const membership = await identityService.getMembership(id, actor.organizationId);
    if (!membership) throw notFound("Membership not found.");
    await identityService.assignRole(membership.id, roleId, actor.identityId);

    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId,
      actorId: actor.identityId, actorDid: actor.did, actorKind: actor.kind,
      action: "ROLE_ASSIGNED", resourceType: "MEMBERSHIP", resourceId: id,
      decision: "EXECUTED", payload: { roleId },
    });
    return { effectivePermissions: await identityService.effectivePermissions(id, actor.organizationId) };
  });

  app.delete("/api/identities/:id/roles/:roleId", async (req) => {
    const actor = requireHuman(req);
    const { id, roleId } = req.params as { id: string; roleId: string };
    const enforcement = await authz.enforce({ actor, action: "ROLE_ASSIGN", resource: { type: "MEMBERSHIP", id }, ip: req.ip });
    const membership = await identityService.getMembership(id, actor.organizationId);
    if (!membership) throw notFound("Membership not found.");
    await identityService.removeRole(membership.id, roleId);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ROLE_REMOVED", resourceType: "MEMBERSHIP", resourceId: id,
      decision: "EXECUTED", payload: { roleId },
    });
    return { effectivePermissions: await identityService.effectivePermissions(id, actor.organizationId) };
  });

  app.post("/api/identities/:id/scopes", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const { scopeId } = req.body as { scopeId: string };
    if (!scopeId) throw badRequest("SCOPE_REQUIRED", "scopeId is required.");
    const enforcement = await authz.enforce({ actor, action: "SCOPE_ASSIGN", resource: { type: "SCOPE", id: scopeId }, ip: req.ip });
    const membership = await identityService.getMembership(id, actor.organizationId);
    if (!membership) throw notFound("Membership not found.");
    await identityService.assignScopeToMembership(membership.id, scopeId);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "SCOPE_ASSIGNED", resourceType: "MEMBERSHIP", resourceId: id,
      decision: "EXECUTED", payload: { scopeId },
    });
    return { effectivePermissions: await identityService.effectivePermissions(id, actor.organizationId) };
  });

  app.delete("/api/identities/:id/scopes/:scopeId", async (req) => {
    const actor = requireHuman(req);
    const { id, scopeId } = req.params as { id: string; scopeId: string };
    await authz.enforce({ actor, action: "SCOPE_ASSIGN", resource: { type: "SCOPE", id: scopeId }, ip: req.ip });
    const membership = await identityService.getMembership(id, actor.organizationId);
    if (!membership) throw notFound("Membership not found.");
    await identityService.removeScopeFromMembership(membership.id, scopeId);
    return { effectivePermissions: await identityService.effectivePermissions(id, actor.organizationId) };
  });

  app.patch("/api/identities/:id/department", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const { departmentId } = req.body as { departmentId: string | null };
    await authz.enforce({ actor, action: "IDENTITY_UPDATE", resource: { type: "IDENTITY", id }, ip: req.ip });
    const membership = await identityService.getMembership(id, actor.organizationId);
    if (!membership) throw notFound("Membership not found.");
    await identityService.setMembershipDepartment(membership.id, departmentId ?? null);
    return { effectivePermissions: await identityService.effectivePermissions(id, actor.organizationId) };
  });

  /* ------------------------------------------------------ roles & capabilities */

  app.get("/api/capabilities", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "CAPABILITY_READ", resource: { type: "CAPABILITY", query: true }, ip: req.ip });
    return { capabilities: CAPABILITIES };
  });

  app.get("/api/roles", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "ROLE_READ", resource: { type: "ROLE", query: true }, ip: req.ip });
    return { roles: await orgService.listRoles(actor.organizationId) };
  });

  app.get("/api/roles/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "ROLE_READ", resource: { type: "ROLE", id }, ip: req.ip });
    const role = await orgService.getRole(actor.organizationId, id);
    if (!role) throw notFound("Role not found.");
    const members = many<any>(
      `SELECT i.id, i.display_name, i.did, i.status FROM identities i
       JOIN memberships m ON m.identity_id = i.id
       JOIN membership_roles mr ON mr.membership_id = m.id
       WHERE mr.role_id = ?`, id);
    return { role, members };
  });

  app.post("/api/roles", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createRole, req.body);
    const enforcement = await authz.enforce({ actor, action: "ROLE_CREATE", resource: { type: "ROLE" }, ip: req.ip, payload: { name: body.name } });
    const role = orgService.createRole(actor.organizationId, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ROLE_CREATED", resourceType: "ROLE", resourceId: (await role).id,
      decision: "EXECUTED", payload: { name: body.name, capabilities: body.capabilities },
    });
    return reply.code(201).send({ role });
  });

  app.patch("/api/roles/:id", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.updateRole, req.body);
    const enforcement = await authz.enforce({ actor, action: "ROLE_UPDATE", resource: { type: "ROLE", id }, ip: req.ip });

    const before = await orgService.getRole(actor.organizationId, id);
    if (!before) throw notFound("Role not found.");
    if (body.name || body.description !== undefined) await orgService.updateRole(actor.organizationId, id, body);
    if (body.capabilities) {
      await authz.enforce({ actor, action: "CAPABILITY_ASSIGN", resource: { type: "ROLE", id }, ip: req.ip });
      await orgService.setRoleCapabilities(actor.organizationId, id, body.capabilities);
    }
    const after = (await orgService.getRole(actor.organizationId, id))!;

    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ROLE_UPDATED", resourceType: "ROLE", resourceId: id,
      decision: "EXECUTED",
      payload: {
        // Capability diffs are recorded explicitly — "role changed" alone would not tell
        // an auditor whether a privilege was added or removed.
        added: after.capabilities.filter((c: string) => !before.capabilities.includes(c)),
        removed: before.capabilities.filter((c: string) => !after.capabilities.includes(c)),
        versionBefore: before.version, versionAfter: after.version,
      },
    });
    return { role: after };
  });

  app.delete("/api/roles/:id", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const enforcement = await authz.enforce({ actor, action: "ROLE_UPDATE", resource: { type: "ROLE", id }, ip: req.ip });
    await orgService.deleteRole(actor.organizationId, id);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "ROLE_DELETED", resourceType: "ROLE", resourceId: id, decision: "EXECUTED",
    });
    return { ok: true };
  });

  app.post("/api/roles/:id/scopes", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const { scopeId } = req.body as { scopeId: string };
    await authz.enforce({ actor, action: "SCOPE_ASSIGN", resource: { type: "ROLE", id }, ip: req.ip });
    await orgService.attachScopeToRole(id, scopeId);
    return { role: await orgService.getRole(actor.organizationId, id) };
  });

  app.delete("/api/roles/:id/scopes/:scopeId", async (req) => {
    const actor = requireHuman(req);
    const { id, scopeId } = req.params as { id: string; scopeId: string };
    await authz.enforce({ actor, action: "SCOPE_ASSIGN", resource: { type: "ROLE", id }, ip: req.ip });
    await orgService.detachScopeFromRole(id, scopeId);
    return { role: await orgService.getRole(actor.organizationId, id) };
  });

  /* -------------------------------------------------------------------- scopes */

  app.get("/api/scopes", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "SCOPE_READ", resource: { type: "SCOPE", query: true }, ip: req.ip });
    const scopes = await orgService.listScopes(actor.organizationId);
    return { scopes: scopes.map(authz.toScopeRecord) };
  });

  app.post("/api/scopes", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createScope, req.body);
    const enforcement = await authz.enforce({ actor, action: "SCOPE_CREATE", resource: { type: "SCOPE" }, ip: req.ip, payload: { name: body.name } });
    const scope = await orgService.createScope(actor.organizationId, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "SCOPE_CREATED", resourceType: "SCOPE", resourceId: scope.id,
      decision: "EXECUTED", payload: { name: body.name, scopeType: body.scopeType, selector: body.selector },
    });
    return reply.code(201).send({ scope: authz.toScopeRecord(scope) });
  });

  app.patch("/api/scopes/:id", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "SCOPE_CREATE", resource: { type: "SCOPE", id }, ip: req.ip });
    const scope = await orgService.updateScope(actor.organizationId, id, req.body as any);
    return { scope: authz.toScopeRecord(scope) };
  });

  /* ------------------------------------------------------------------ policies */

  app.get("/api/policies", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "POLICY_READ", resource: { type: "POLICY", query: true }, ip: req.ip });
    const q = req.query as any;
    return { policies: (await policyService.listPolicies(actor.organizationId, { status: q.status, includeAllVersions: q.allVersions === "true" })).map(policyService.toApi) };
  });

  app.get("/api/policies/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "POLICY_READ", resource: { type: "POLICY", id }, ip: req.ip });
    const policy = await policyService.getPolicy(actor.organizationId, id);
    if (!policy) throw notFound("Policy not found.");
    return {
      policy: policyService.toApi(policy),
      versions: (await policyService.policyVersions(actor.organizationId, policy.policy_key)).map(policyService.toApi),
      decisionHistory: await policyService.decisionHistory(actor.organizationId, id),
    };
  });

  app.post("/api/policies", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createPolicy, req.body);
    const enforcement = await authz.enforce({ actor, action: "POLICY_CREATE", resource: { type: "POLICY" }, ip: req.ip, payload: { policyKey: body.policyKey } });
    const { policy, warnings } = await policyService.createPolicy(actor.organizationId, actor.identityId, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "POLICY_CREATED", resourceType: "POLICY", resourceId: policy.id,
      decision: "EXECUTED", policyId: policy.id, policyVersion: policy.version,
      payload: { policyKey: body.policyKey, hash: policy.hash, activated: body.activate, warnings },
    });
    return reply.code(201).send({ policy: policyService.toApi(policy), warnings });
  });

  app.post("/api/policies/:policyKey/versions", async (req, reply) => {
    const actor = requireHuman(req);
    const { policyKey } = req.params as { policyKey: string };
    const body = validate(S.newPolicyVersion, req.body);
    const enforcement = await authz.enforce({ actor, action: "POLICY_UPDATE", resource: { type: "POLICY", id: policyKey }, ip: req.ip });
    const { policy, warnings } = await policyService.createVersion(actor.organizationId, actor.identityId, policyKey, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "POLICY_VERSION_CREATED", resourceType: "POLICY", resourceId: policy.id,
      decision: "EXECUTED", policyId: policy.id, policyVersion: policy.version,
      payload: { policyKey, version: policy.version, hash: policy.hash, activated: body.activate, warnings },
    });
    return reply.code(201).send({ policy: policyService.toApi(policy), warnings });
  });

  app.post("/api/policies/:id/activate", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const enforcement = await authz.enforce({ actor, action: "POLICY_ACTIVATE", resource: { type: "POLICY", id }, ip: req.ip });
    const policy = await policyService.activatePolicy(actor.organizationId, id);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "POLICY_ACTIVATED", resourceType: "POLICY", resourceId: id,
      decision: "EXECUTED", policyId: id, policyVersion: policy.version, payload: { hash: policy.hash },
    });
    return { policy: policyService.toApi(policy) };
  });

  app.post("/api/policies/:id/disable", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const enforcement = await authz.enforce({ actor, action: "POLICY_DISABLE", resource: { type: "POLICY", id }, ip: req.ip });
    const policy = await policyService.disablePolicy(actor.organizationId, id);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "POLICY_DISABLED", resourceType: "POLICY", resourceId: id, decision: "EXECUTED",
    });
    return { policy: policyService.toApi(policy) };
  });

  /* --------------------------------------------------- permission simulator */

  /**
   * Answers "what would happen if X tried Y?" without doing it. Uses `check` rather
   * than `enforce`, so running a simulation never mutates state or produces a
   * misleading ALLOW in the real audit trail.
   */
  app.post("/api/authorize/simulate", async (req) => {
    const actor = requireActor(req);
    const body = validate(S.simulate, req.body);
    await authz.enforce({ actor, action: "PERMISSION_SIMULATE", resource: { type: "PERMISSION", query: true }, ip: req.ip });

    let subject = actor;
    if (body.identityId && body.identityId !== actor.identityId) {
      const built = await identityService.buildActorContext(body.identityId, actor.organizationId);
      if (!built) throw notFound("Subject identity not found in this organization.");
      subject = built;
    } else if (body.agentId) {
      const agent = await one<any>(`SELECT identity_id FROM agents WHERE id = ? AND organization_id = ?`, body.agentId, actor.organizationId);
      if (!agent) throw notFound("Agent not found.");
      const built = await identityService.buildActorContext(agent.identity_id, actor.organizationId);
      if (!built) throw notFound("Agent identity could not be resolved.");
      subject = built;
    }

    const result = await authz.check({
      actor: subject, action: body.action,
      resource: { ...body.resource, organizationId: actor.organizationId },
      context: body.context,
      traceId: newTraceId(),
    });

    return {
      subject: { identityId: subject.identityId, did: subject.did, kind: subject.kind, roles: subject.roleNames, capabilities: [...subject.capabilities].sort() },
      result,
      simulated: true,
    };
  });

  /* ------------------------------------------- organization, security, emergency */

  app.get("/api/organization", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "ORG_READ", resource: { type: "ORGANIZATION", id: actor.organizationId }, ip: req.ip });
    return {
      organization: await orgService.getOrganization(actor.organizationId),
      departments: await orgService.listDepartments(actor.organizationId),
      emergencyFlags: await orgService.listEmergencyFlags(actor.organizationId),
    };
  });

  app.post("/api/organization/departments", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.createDepartment, req.body);
    await authz.enforce({ actor, action: "ORG_MANAGE", resource: { type: "ORGANIZATION", id: actor.organizationId }, ip: req.ip });
    return reply.code(201).send({ department: await orgService.createDepartment(actor.organizationId, body.name, body.code.toUpperCase()) });
  });

  app.get("/api/security/events", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "SECURITY_READ", resource: { type: "SECURITY", query: true }, ip: req.ip });
    const events = await orgService.listSecurityEvents(actor.organizationId);
    return { events: events.map((e) => ({
      id: e.id, kind: e.kind, severity: e.severity, actorId: e.actor_id,
      summary: e.summary, detail: JSON.parse(e.detail_json || "{}"),
      acknowledgedAt: e.acknowledged_at, createdAt: e.created_at,
    })) };
  });

  app.post("/api/security/events/:id/acknowledge", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    await authz.enforce({ actor, action: "SECURITY_READ", resource: { type: "SECURITY", id }, ip: req.ip });
    orgService.acknowledgeSecurityEvent(actor.organizationId, id);
    return { ok: true };
  });

  app.get("/api/security/emergency", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "SECURITY_READ", resource: { type: "ORGANIZATION", id: actor.organizationId }, ip: req.ip });
    return { flags: orgService.listEmergencyFlags(actor.organizationId) };
  });

  app.post("/api/security/emergency", async (req) => {
    const actor = requireHuman(req);
    const body = validate(S.emergencyFlag, req.body);
    const enforcement = await authz.enforce({
      actor, action: "EMERGENCY_CONTROL",
      resource: { type: "ORGANIZATION", id: actor.organizationId }, ip: req.ip,
      payload: { flagKey: body.flagKey, enabled: body.enabled },
    });
    const flag = orgService.setEmergencyFlag(actor.organizationId, body.flagKey, body.enabled, actor.identityId, body.reason);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: body.enabled ? "EMERGENCY_ENABLED" : "EMERGENCY_DISABLED",
      resourceType: "ORGANIZATION", resourceId: actor.organizationId, decision: "EXECUTED",
      payload: { flagKey: body.flagKey, reason: body.reason },
    });
    orgService.recordSecurityEvent({
      organizationId: actor.organizationId, kind: "EMERGENCY_CONTROL", severity: "CRITICAL",
      actorId: actor.identityId,
      summary: `${body.flagKey} was ${body.enabled ? "ENABLED" : "disabled"} by an administrator.`,
      detail: { reason: body.reason },
    });
    return { flag, flags: orgService.listEmergencyFlags(actor.organizationId) };
  });
}
