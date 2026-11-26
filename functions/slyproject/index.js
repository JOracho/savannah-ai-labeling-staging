import { createRemoteJWKSet, jwtVerify } from "jose";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGINS = new Set([
  "https://joracho.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
]);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

const jwks = process.env.NEON_AUTH_JWKS_URL
  ? createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL))
  : null;
const issuer = process.env.NEON_AUTH_BASE_URL
  ? new URL(process.env.NEON_AUTH_BASE_URL).origin
  : null;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://joracho.github.io",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Vary": "Origin"
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request) {
    const headers = cors(request.headers.get("origin") || "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405, headers);
    }

    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return json({ error: "Sign in is required." }, 401, headers);
    }
    if (!jwks || !issuer || !process.env.DATABASE_URL) {
      return json({ error: "Savannah authentication or database configuration is unavailable." }, 503, headers);
    }

    let userId;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer });
      if (!UUID.test(String(payload.sub || ""))) {
        return json({ error: "Invalid session." }, 401, headers);
      }
      userId = payload.sub;
    } catch {
      return json({ error: "Your session is invalid or has expired. Please sign in again." }, 401, headers);
    }

    const dbUrl = process.env.DATABASE_URL;
    let dbUrlInfo = { present: typeof dbUrl === "string" && dbUrl.length > 0, type: typeof dbUrl };
    try {
      const parsedDbUrl = new URL(dbUrl);
      dbUrlInfo = {
        ...dbUrlInfo,
        protocol: parsedDbUrl.protocol,
        hostPresent: Boolean(parsedDbUrl.hostname),
        usernamePresent: Boolean(parsedDbUrl.username),
        passwordPresent: Boolean(parsedDbUrl.password),
        databasePresent: parsedDbUrl.pathname.length > 1
      };
    } catch {
      dbUrlInfo.parseable = false;
    }
    console.info("Database connection diagnostic (no credentials)", dbUrlInfo);

    try {
      const adminResult = await pool.query(
        "SELECT id, role FROM public.profiles WHERE id = $1 LIMIT 1",
        [userId]
      );
      if (adminResult.rows[0]?.role !== "admin") {
        return json({ error: "Administrator access is required." }, 403, headers);
      }

      if (!process.env.SUPERVISELY_API_TOKEN) {
        return json({ error: "SUPERVISELY_API_TOKEN is not configured in Neon Function secrets." }, 503, headers);
      }

      const body = await request.json().catch(() => ({}));
      const existingProjectId = String(body.project_id || "").trim();
      const suppliedClientId = String(body.client_user_id || "").trim();
      let title = String(body.title || "").trim();
      let service = String(body.service_type || "").trim();
      let description = String(body.description || "").trim();
      let clientId = suppliedClientId || userId;

      if (existingProjectId && !UUID.test(existingProjectId)) {
        return json({ error: "The existing Savannah project ID is invalid." }, 400, headers);
      }
      if (suppliedClientId && !UUID.test(suppliedClientId)) {
        return json({ error: "The selected client account ID is invalid." }, 400, headers);
      }

      if (existingProjectId) {
        const existingResult = await pool.query(
          `SELECT id, client_user_id, title, service_type, description,
                  annotation_tool, annotation_workspace_url, tool_access_mode
           FROM public.projects WHERE id = $1 LIMIT 1`,
          [existingProjectId]
        );
        const existingProject = existingResult.rows[0];
        if (!existingProject) {
          return json({ error: "The Savannah project to attach was not found." }, 404, headers);
        }
        if (existingProject.annotation_tool || existingProject.annotation_workspace_url) {
          if (
            existingProject.annotation_tool === "supervisely" &&
            existingProject.annotation_workspace_url
          ) {
            const match = existingProject.annotation_workspace_url.match(/\/projects\/(\d+)/);
            return json({
              success: true,
              already_assigned: true,
              project: existingProject,
              supervisely_project_id: match?.[1] || null,
              workspace_id: 142007,
              workspace_url: existingProject.annotation_workspace_url
            }, 200, headers);
          }
          return json({ error: "This Savannah project already has an annotation tool assigned. No new workspace was created." }, 409, headers);
        }
        if (existingProject.tool_access_mode !== "managed") {
          return json({ error: "Only Savannah-managed projects can be attached to the managed Supervisely workspace." }, 409, headers);
        }
        title = existingProject.title;
        service = existingProject.service_type;
        description = existingProject.description || "";
        clientId = existingProject.client_user_id;
      } else {
        if (!title || title.length > 120 || !service || service.length > 100 || description.length > 2000) {
          return json({ error: "Enter a project title, service type and description within the stated limits." }, 400, headers);
        }
        if (suppliedClientId) {
          const clientResult = await pool.query(
            "SELECT id FROM public.profiles WHERE id = $1 LIMIT 1",
            [clientId]
          );
          if (!clientResult.rows.length) {
            return json({ error: "The selected client account was not found. Confirm the client has registered in Savannah." }, 404, headers);
          }
        }
      }

      const requestedDataType = String(body.data_type || "").trim();
      let projectType;
      if (existingProjectId) {
        if (!["point_clouds", "images", "videos"].includes(requestedDataType)) {
          return json({ error: "Choose a supported Supervisely data type: point clouds, images or videos." }, 400, headers);
        }
        projectType = requestedDataType;
      } else {
        const normalizedService = service.toLowerCase();
        projectType =
          normalizedService.includes("lidar") ||
          normalizedService.includes("point cloud") ||
          normalizedService.includes("3d")
            ? "point_clouds"
            : normalizedService.includes("video")
              ? "videos"
              : "images";
      }

      // Supervisely project names cannot contain slash, backslash or pipe characters.
      // Keep the original title in Savannah; sanitize only the external project name.
      const superviselyName = title
        .replace(/\s*[\/\\|]+\s*/g, " - ")
        .replace(/\s+/g, " ")
        .trim();

      const superviselyResponse = await fetch("https://app.supervisely.com/public/api/v3/projects.add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.SUPERVISELY_API_TOKEN
        },
        body: JSON.stringify({
          workspaceId: 142007,
          name: superviselyName,
          description,
          type: projectType
        })
      });

      const raw = await superviselyResponse.text();
      let result = {};
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        result = {};
      }

      let duplicateProjectId = null;
      if (!superviselyResponse.ok) {
        const duplicate = result?.details?.errors?.find(
          (item) => item?.type === "NONUNIQUE" || result?.details?.type === "NONUNIQUE"
        );
        if (
          superviselyResponse.status === 400 &&
          result?.details?.type === "NONUNIQUE" &&
          duplicate?.name === superviselyName &&
          /^\d+$/.test(String(duplicate?.id || ""))
        ) {
          duplicateProjectId = String(duplicate.id);
          console.info("Using existing Supervisely project after duplicate-name response", {
            projectId: duplicateProjectId
          });
        } else {
          return json({
            error: "Supervisely API error.",
            supervisely_status: superviselyResponse.status,
            supervisely_response: raw.slice(0, 1000)
          }, 502, headers);
        }
      }

      const projectData = result.data || result.project || result;
      const externalProjectId = duplicateProjectId || projectData.id || projectData.projectId || result.id;
      if (!/^\d+$/.test(String(externalProjectId || ""))) {
        return json({
          error: "Supervisely responded without a usable project ID. Check Supervisely before retrying to avoid a duplicate."
        }, 502, headers);
      }

      const workspaceUrl = `https://app.supervisely.com/projects/${externalProjectId}/datasets`;
      let saved;
      if (existingProjectId) {
        saved = await pool.query(
          `UPDATE public.projects
           SET annotation_tool = 'supervisely',
               annotation_workspace_url = $2,
               tool_access_mode = 'managed',
               updated_at = now()
           WHERE id = $1
             AND annotation_tool IS NULL
             AND annotation_workspace_url IS NULL
           RETURNING *`,
          [existingProjectId, workspaceUrl]
        );
        if (!saved.rows.length) {
          return json({
            error: "The Supervisely workspace was created, but the Savannah project changed before it could be linked. Check the project before retrying.",
            supervisely_project_id: String(externalProjectId),
            workspace_url: workspaceUrl
          }, 409, headers);
        }
      } else {
        saved = await pool.query(
          `INSERT INTO public.projects
            (client_user_id, title, service_type, description, annotation_tool,
             annotation_workspace_url, tool_access_mode, status, progress_percent)
           VALUES ($1, $2, $3, $4, 'supervisely', $5, 'managed', 'project_submitted', 0)
           RETURNING * `,
          [clientId, title, service, description || null, workspaceUrl]
        );
      }

      return json({
        success: true,
        project: saved.rows[0],
        supervisely_project_id: String(externalProjectId),
        workspace_id: 142007,
        workspace_url: workspaceUrl
      }, existingProjectId ? 200 : 201, headers);
    } catch (error) {
      console.error("Supervisely project creation failed:", error);
      return json({
        error: error?.message || "Unable to create the Supervisely project."
      }, 500, headers);
    }
  }
};
