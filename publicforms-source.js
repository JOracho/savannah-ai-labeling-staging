import { createHash, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";

const databaseUrl = process.env.DATABASE_URL;
const webhookToken = process.env.FORM_WEBHOOK_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!webhookToken) throw new Error("FORM_WEBHOOK_TOKEN is required");

const pool = new Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 10_000 });
attachDatabasePool(pool);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function plainFields(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item).trim();
    } else if (item && typeof item === "object" && typeof item.name === "string") {
      out[key] = item.name;
    }
  }
  return out;
}

async function readPayload(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const fields = {};
    for (const [key, value] of form.entries()) fields[key] = typeof value === "string" ? value.trim() : value.name;
    const canonical = JSON.stringify(fields);
    return { payload: fields, rawForHash: canonical };
  }
  const raw = await request.text();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return { payload: Object.fromEntries(new URLSearchParams(raw)), rawForHash: raw };
  }
  try {
    return { payload: JSON.parse(raw), rawForHash: raw };
  } catch {
    const params = new URLSearchParams(raw);
    const fields = Object.fromEntries(params.entries());
    if (Object.keys(fields).length) return { payload: fields, rawForHash: raw };
    throw new Error("Unsupported or invalid webhook body");
  }
}

function extractSubmission(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  let data = payload.form_data ?? payload.submission?.data ?? payload.data ?? payload;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    fields: plainFields(data),
    formName: String(payload.form?.name ?? payload.form_name ?? "").toLowerCase(),
    event: String(payload.event ?? "").toLowerCase(),
    submissionId: String(payload.submission?.id ?? payload.submission_id ?? ""),
  };
}

function text(value, max = 10_000) { return String(value ?? "").trim().slice(0, max); }
const allowedOrigin = "https://joracho.github.io";
function json(body, status = 200, origin = "") {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "vary": "Origin" };
  if (origin === allowedOrigin) {
    headers["access-control-allow-origin"] = allowedOrigin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("origin") || "";
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "formsubmit" || !safeEqual(parts[1], webhookToken)) {
      return json({ ok: false, error: "Unauthorized" }, 401, origin);
    }
    if (origin && origin !== allowedOrigin) return json({ ok: false, error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin",
      }});
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, origin);
    let client;
    try {
      const { payload, rawForHash } = await readPayload(request);
      const submission = extractSubmission(payload);
      const eventHeader = (request.headers.get("x-formsubmit-event") || "").toLowerCase();
      if (eventHeader === "test" || submission?.event === "test") return json({ ok: true, received: "test" }, 200, origin);
      if (!submission) return json({ ok: false, error: "No submission fields found" }, 400, origin);

      const f = submission.fields;
      const name = text(f.name ?? f.full_name, 200);
      const email = text(f.email, 320).toLowerCase();
      const message = text(f.message ?? f.experience_summary, 10_000);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) {
        return json({ ok: false, error: "Required name, valid email, or message is missing" }, 400, origin);
      }
      const isAnnotator = Boolean(f.experience || f.resume || submission.formName.includes("annotator") || f.portfolio);
      const submissionType = isAnnotator ? "annotator" : "client";
      const payloadHash = createHash("sha256")
        .update(submission.submissionId ? `${submissionType}:${submission.submissionId}` : rawForHash).digest("hex");

      client = await pool.connect();
      await client.query("BEGIN");
      const eventInsert = await client.query(
        `INSERT INTO private.form_webhook_events (payload_hash, submission_type)
         VALUES ($1, $2) ON CONFLICT (payload_hash) DO NOTHING RETURNING id`,
        [payloadHash, submissionType],
      );
      if (eventInsert.rowCount === 0) {
        await client.query("COMMIT");
        return json({ ok: true, duplicate: true }, 200, origin);
      }
      if (isAnnotator) {
        const experienceArea = text(f.experience ?? f.experience_area, 200);
        if (!experienceArea) {
          await client.query("ROLLBACK");
          return json({ ok: false, error: "Annotator experience area is missing" }, 400, origin);
        }
        await client.query(
          `INSERT INTO public.annotator_applications
             (full_name, email, experience_area, portfolio_url, experience_summary, cv_storage_path)
           VALUES ($1, $2, $3, $4, $5, NULL)`,
          [name, email, experienceArea, text(f.portfolio ?? f.portfolio_url, 2_000) || null, message],
        );
      } else {
        const service = text(f.service, 200);
        if (!service) {
          await client.query("ROLLBACK");
          return json({ ok: false, error: "Client service selection is missing" }, 400, origin);
        }
        await client.query(
          `INSERT INTO public.client_inquiries (name, email, company, service, message)
           VALUES ($1, $2, $3, $4, $5)`,
          [name, email, text(f.company, 200) || null, service, message],
        );
      }
      await client.query("COMMIT");
      return json({ ok: true, received: submissionType }, 200, origin);
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch { /* keep original error */ } }
      console.error("publicforms processing failed:", error?.message || "unknown error");
      return json({ ok: false, error: "Webhook processing failed" }, 500, origin);
    } finally { client?.release(); }
  },
};
