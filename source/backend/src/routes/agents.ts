import type { FastifyInstance } from "fastify";
import * as S from "../schemas/index.js";
import { validate } from "./_helpers.js";
import { requireActor, requireHuman } from "../auth/middleware.js";
import * as agentService from "../services/agentService.js";
import * as toolGateway from "../services/toolGateway.js";
import * as orchestrator from "../services/agentOrchestrator.js";
import * as authz from "../services/authorizationService.js";
import * as audit from "../services/auditService.js";
import { toolCatalog } from "../services/toolRegistry.js";
import { getBlockchainAdapter } from "../adapters/blockchain/index.js";
import { didCommitment } from "../auth/did.js";
import { notFound, forbidden } from "../core/errors.js";

export async function agentRoutes(app: FastifyInstance) {
  app.get("/api/agents", async (req) => {
    const actor = requireActor(req);
    await authz.enforce({ actor, action: "AGENT_READ", resource: { type: "AGENT", query: true }, ip: req.ip });
    return await { agents: (await agentService.listAgents(actor.organizationId)).map(agentService.toApi) };
  });

  app.get("/api/agents/tools", async (req) => {
    requireActor(req);
    return { tools: toolCatalog() };
  });

  app.get("/api/agents/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const agent = await agentService.getAgent(actor.organizationId, id);
    if (!agent) throw notFound("Agent not found.");
    await authz.enforce({ actor, action: "AGENT_READ", resource: { type: "AGENT", id, departmentId: (await agent).department_id }, ip: req.ip });
    return {
      agent: (await agentService.toApi(agent)),
      toolCalls: (await agentService.toolCallHistory(id, 50)).map((c) => ({
        id: c.id, traceId: c.trace_id, tool: c.tool_name, args: JSON.parse(c.args_json || "{}"),
        decision: c.decision, reasonCodes: JSON.parse(c.reason_codes || "[]"),
        latencyMs: c.latency_ms, createdAt: c.created_at,
      })),
    };
  });

  /** Independent chain read — proves the agent registry is not decorative. */
  app.get("/api/agents/:id/on-chain", async (req) => {
    const actor = requireActor(req);
    const { id } = req.params as { id: string };
    const agent = agentService.getAgent(actor.organizationId, id);
    if (!agent) throw notFound("Agent not found.");
    await authz.enforce({ actor, action: "AGENT_READ", resource: { type: "AGENT", id }, ip: req.ip });
    const chain = getBlockchainAdapter();
    const onChain = await chain.getAgent(didCommitment(id));
    return {
      onChain, adapterKind: chain.kind, chainId: chain.chainId,
      databaseStatus: (await agent).status,
      statusAgrees: onChain.exists ? onChain.active === ((await agent).status === "ACTIVE") : null,
      note: chain.kind === "memory"
        ? "Read from the in-memory chain simulation. Deterministic and invariant-enforcing, but not externally verifiable."
        : "Read directly from the deployed contract, independent of the application database.",
    };
  });

  app.post("/api/agents", async (req, reply) => {
    const actor = requireHuman(req);
    const body = validate(S.registerAgent, req.body);
    const enforcement = await authz.enforce({
      actor, action: "AGENT_REGISTER", resource: { type: "AGENT", departmentId: body.departmentId ?? null },
      ip: req.ip, payload: { name: body.name, capabilities: body.capabilities, tools: body.tools },
    });

    // Escalation guard: an admin cannot grant an agent a capability the admin does not
    // themselves hold. Without this, "register an agent" becomes a privilege-escalation
    // primitive for any account that happens to hold AGENT_REGISTER.
    const overreach = body.capabilities.filter((c) => !actor.capabilities.has(c));
    if (overreach.length) {
      throw forbidden("CAPABILITY_MISSING", `You cannot grant capabilities you do not hold: ${overreach.join(", ")}.`);
    }

    const { agent, token } = await agentService.registerAgent(actor, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "AGENT_REGISTERED", resourceType: "AGENT", resourceId: (await agent).id,
      decision: "EXECUTED",
      payload: { name: body.name, did: (await agent).did, capabilities: body.capabilities, tools: body.tools, limits: body.limits },
    });
    return reply.code(201).send({
      agent: (await agentService.toApi(agent)),
      token,
      tokenNotice: "This agent key is shown once and only its hash is stored. Save it now.",
    });
  });

  app.patch("/api/agents/:id/policy", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.configureAgent, req.body);
    const agent = await agentService.getAgent(actor.organizationId, id);
    if (!agent) throw notFound("Agent not found.");
    const enforcement = await authz.enforce({ actor, action: "AGENT_CONFIGURE", resource: { type: "AGENT", id, departmentId: (await agent).department_id }, ip: req.ip });

    const overreach = (body.capabilities ?? []).filter((c) => !actor.capabilities.has(c));
    if (overreach.length) throw forbidden("CAPABILITY_MISSING", `You cannot grant capabilities you do not hold: ${overreach.join(", ")}.`);

    const before = (await agentService.toApi(agent));
    const updated = await agentService.configureAgent(actor.organizationId, id, body);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "AGENT_CONFIGURED", resourceType: "AGENT", resourceId: id,
      decision: "EXECUTED",
      payload: {
        capabilitiesBefore: before.capabilities, capabilitiesAfter: (await agentService.toApi(updated)).capabilities,
        toolsBefore: before.tools, toolsAfter: (await agentService.toApi(updated)).tools,
        limitsBefore: before.limits, limitsAfter: (await agentService.toApi(updated)).limits,
      },
    });
    return { agent: (await agentService.toApi(updated)) };
  });

  app.post("/api/agents/:id/freeze", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const body = validate(S.agentStatus, req.body);
    const agent = await agentService.getAgent(actor.organizationId, id);
    if (!agent) throw notFound("Agent not found.");
    const enforcement = await authz.enforce({ actor, action: "AGENT_FREEZE", resource: { type: "AGENT", id, departmentId: (await agent).department_id }, ip: req.ip, payload: { status: body.status } });
    const updated = await agentService.setAgentStatus(actor.organizationId, id, body.status, actor.identityId, body.reason);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: `AGENT_${body.status}`, resourceType: "AGENT", resourceId: id,
      decision: "EXECUTED", payload: { reason: body.reason, sessionsRevoked: body.status !== "ACTIVE" },
    });
    return { agent: (await agentService.toApi(updated)) };
  });

  app.post("/api/agents/:id/rotate-token", async (req) => {
    const actor = requireHuman(req);
    const { id } = req.params as { id: string };
    const enforcement = await authz.enforce({ actor, action: "AGENT_CONFIGURE", resource: { type: "AGENT", id }, ip: req.ip });
    const { token } = await  agentService.rotateToken(actor.organizationId, id);
    audit.record({
      organizationId: actor.organizationId, traceId: enforcement.traceId, actorId: actor.identityId,
      actorDid: actor.did, action: "AGENT_TOKEN_ROTATED", resourceType: "AGENT", resourceId: id, decision: "EXECUTED",
    });
    return { token, tokenNotice: "The previous key is now invalid." };
  });

  /**
   * Direct tool invocation. Callable by an agent with its own key, or by a human
   * testing a tool. Either way it goes through the gateway — there is no privileged
   * variant of this endpoint.
   */
  app.post("/api/agents/tools/invoke", async (req) => {
    const actor = requireActor(req);
    const body = validate(S.toolInvoke, req.body);
    const result = await toolGateway.invoke({ actor, toolName: body.tool, args: body.args, ip: req.ip });
    return result;
  });

  /** Natural-language task: RAG → proposal → risk → gateway. */
  app.post("/api/agents/task", async (req) => {
    const actor = requireActor(req);
    const body = validate(S.agentTask, req.body);
    // Invoking the agent task loop is authorized at the capability level; every action
    // the loop then proposes is re-authorized individually inside the Tool Gateway, so
    // this gate deliberately does not stand in for the per-action checks.
    await authz.enforce({
      actor, action: "AGENT_INVOKE",
      resource: { type: "AGENT", id: actor.agent?.id ?? null, query: true, departmentId: actor.departmentId },
      ip: req.ip, payload: { execute: body.execute },
    });
    return orchestrator.run(actor, body.instruction, { execute: body.execute });
  });
}
