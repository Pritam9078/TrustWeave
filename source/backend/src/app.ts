import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env, assertSafeConfig, CORS_ORIGINS } from "./config/env.js";
import { AppError } from "./core/errors.js";
import { attachActor } from "./auth/middleware.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { assetRoutes } from "./routes/assets.js";
import { agentRoutes } from "./routes/agents.js";
import { paymentRoutes } from "./routes/payments.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { auditRoutes } from "./routes/audit.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { dashboardRoutes } from "./routes/dashboard.js";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers['x-agent-key']", "req.headers['x-razorpay-signature']"] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  assertSafeConfig({ warn: (m) => app.log.warn(m) });

  await app.register(cors, {
    origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-agent-key", "x-razorpay-signature", "x-idempotency-key"],
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Rate-limit agents by their own key, not by IP. Several agents behind one egress
    // address would otherwise share a bucket and throttle each other.
    keyGenerator: (req) => String(req.headers["x-agent-key"] ?? req.headers.authorization ?? req.ip),
  });

  /**
   * Raw-body capture. Signature verification must run over the exact bytes the provider
   * signed; JSON.stringify(JSON.parse(body)) is not byte-identical (key order, spacing,
   * number formatting), so verifying against a re-serialised body would reject valid
   * deliveries. We keep the original string and parse separately.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body: string, done) => {
    (req as any).rawBodyString = body;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); }
    catch { done(Object.assign(new Error("Malformed JSON body."), { statusCode: 400 }), undefined); }
  });

  app.addHook("onRequest", attachActor);

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      // A DENY has already been written to the audit log by `enforce`. Returning the
      // reason code lets the UI explain *why* rather than showing a generic failure.
      return reply.code(error.status).send({
        error: error.code, message: error.message, details: error.details ?? null,
      });
    }
    if ((error as any).validation) {
      return reply.code(400).send({ error: "VALIDATION_FAILED", message: error.message });
    }
    if ((error as any).statusCode === 429) {
      return reply.code(429).send({ error: "RATE_LIMITED", message: "Too many requests. Slow down and try again shortly." });
    }
    request.log.error({ err: error }, "Unhandled error");
    // Never leak internals to the client; the stack is in the server log.
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "An unexpected error occurred." });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "NOT_FOUND", message: `No route for ${request.method} ${request.url}.` });
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(assetRoutes);
  await app.register(agentRoutes);
  await app.register(paymentRoutes);
  await app.register(webhookRoutes);
  await app.register(auditRoutes);
  await app.register(knowledgeRoutes);
  await app.register(dashboardRoutes);

  return app;
}
