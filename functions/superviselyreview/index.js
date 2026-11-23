import { createHmac, createHash } from 'node:crypto';

const BUCKET = 'annotation-review';
const ALLOWED_ORIGINS = ['https://joracho.github.io', 'http://localhost:3000', 'http://127.0.0.1:5500'];
const encode = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPERVISELY_API = 'https://app.supervisely.com/public/api/v3';

function headers(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Vary': 'Origin'
  };
}
function response(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function sign(method, key, contentType = '', expires = 300) {
  const endpoint = new URL(process.env.AWS_ENDPOINT_URL_S3);
  const region = process.env.AWS_REGION;
  const access = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  if (!access || !secret || !region) throw new Error('Neon Object Storage credentials are not available to this function.');
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const uri = (endpoint.pathname.replace(/\/$/, '') || '') + '/' + BUCKET + '/' + key.split('/').map(encode).join('/');
  const signedHeaders = contentType ? 'content-type;host' : 'host';
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${access}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders
  };
  const canonicalQuery = Object.keys(query).sort().map(k => encode(k) + '=' + encode(query[k])).join('&');
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${endpoint.host}\n`
    : `host:${endpoint.host}\n`;
  const canonicalRequest = `${method}\n${uri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const hash = createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash}`;
  const hmac = (keyBytes, value) => createHmac('sha256', keyBytes).update(value).digest();
  const kDate = hmac('AWS4' + secret, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${endpoint.origin}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
async function db(path, token, options = {}) {
  const result = await fetch(process.env.NEON_DATA_API_URL.replace(/\/$/, '') + path, {
    ...options,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const raw = await result.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw }; }
  if (!result.ok) throw new Error(data?.message || data?.details || 'Savannah database request failed.');
  return data;
}
async function supervisely(path, body, apiHeaders) {
  const result = await fetch(SUPERVISELY_API + '/' + path, {
    method: 'POST', headers: apiHeaders, body: JSON.stringify(body)
  });
  const raw = await result.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (!result.ok) throw new Error(`Supervisely ${path} failed (${result.status}).`);
  return data?.data ?? data;
}
function countLabels(annotation) {
  if (Array.isArray(annotation?.frames)) return annotation.frames.reduce((total, frame) => total + (Array.isArray(frame?.figures) ? frame.figures.length : 0), 0);
  if (Array.isArray(annotation?.objects)) return annotation.objects.length;
  if (Array.isArray(annotation?.labels)) return annotation.labels.length;
  if (Array.isArray(annotation?.figures)) return annotation.figures.length;
  return 0;
}
function safeName(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export default {
  async fetch(request) {
    const cors = headers(request.headers.get('origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405, cors);

    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return response({ error: 'Sign in required.' }, 401, cors);

    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString());
      if (!UUID.test(claims.sub || '')) return response({ error: 'Invalid session.' }, 401, cors);
      const profile = (await db(`/profiles?select=id,role&id=eq.${encode(claims.sub)}&limit=1`, token))[0];
      if (!profile) return response({ error: 'Create your Savannah profile first.' }, 403, cors);
      const body = await request.json().catch(() => ({}));

      if (body.action === 'list_assignment_annotations') {
        if (!['admin', 'reviewer'].includes(profile.role) || !UUID.test(body.assignment_id || '')) {
          return response({ error: 'Reviewer access required.' }, 403, cors);
        }
        const rows = await db(`/project_annotations?select=id,image_name,media_type,external_dataset_id,external_image_id,label_count,annotation_json,image_storage_path,imported_at&assignment_id=eq.${encode(body.assignment_id)}&external_platform=eq.supervisely&order=imported_at.desc`, token);
        for (const row of rows) row.image_url = sign('GET', row.image_storage_path);
        return response({ success: true, annotations: rows }, 200, cors);
      }

      if (!process.env.SUPERVISELY_API_TOKEN) {
        return response({ error: 'SUPERVISELY_API_TOKEN is not configured in this Neon Function.' }, 503, cors);
      }
      if (body.action !== 'submit' || profile.role !== 'annotator' ||
          !UUID.test(body.assignment_id || '') || !UUID.test(body.project_id || '')) {
        return response({ error: 'A valid annotator assignment is required.' }, 403, cors);
      }

      const assignment = (await db(
        `/project_assignments?select=id,project_id,annotator_user_id,platform,assignment_status,projects(id,annotation_tool,annotation_workspace_url,tool_access_mode)&id=eq.${encode(body.assignment_id)}&annotator_user_id=eq.${encode(claims.sub)}&limit=1`,
        token
      ))[0];
      const project = assignment?.projects;
      if (!assignment || assignment.project_id !== body.project_id ||
          assignment.platform !== 'supervisely' ||
          !['in_progress', 'rework'].includes(assignment.assignment_status) ||
          String(project?.annotation_tool || '').toLowerCase() !== 'supervisely' ||
          project?.tool_access_mode === 'byot') {
        return response({ error: 'Assignment is not ready for managed Supervisely submission.' }, 409, cors);
      }

      const externalProjectId = String(body.external_project_id || '').trim();
      const datasetId = String(body.external_dataset_id || '').trim();
      const requestedMediaType = String(body.media_type || 'image').toLowerCase();
      const mediaType = ['pointcloud', 'video'].includes(requestedMediaType) ? requestedMediaType : 'image';
      const mediaId = String(body.external_video_id || body.external_image_id || body.external_pointcloud_id || '').trim();
      if (!/^\d+$/.test(externalProjectId) || !/^\d+$/.test(datasetId) || !/^\d+$/.test(mediaId)) {
        return response({ error: 'Enter numeric Supervisely project, dataset and image/point-cloud IDs.' }, 400, cors);
      }
      const workspaceMatch = String(project.annotation_workspace_url || '').match(/projects\/(\d+)/);
      if (!workspaceMatch || workspaceMatch[1] !== externalProjectId) {
        return response({ error: 'Supervisely project ID does not match the Savannah workspace.' }, 403, cors);
      }

      const apiHeaders = { 'Content-Type': 'application/json', 'x-api-key': process.env.SUPERVISELY_API_TOKEN };
      let info, annotation, bytes, mime, name, width = null, height = null, annotationCreatedAt = null, annotationUpdatedAt = null;
      if (mediaType === 'image') {
        info = await supervisely('images.info', { id: Number(mediaId), forceMetadataForLinks: true }, apiHeaders);
        if (String(info.datasetId) !== datasetId ||
            (info.projectId && String(info.projectId) !== externalProjectId)) {
          return response({ error: 'The selected image does not belong to the supplied Supervisely dataset/project.' }, 409, cors);
        }
        const annotationInfo = await supervisely('annotations.info', {
          imageId: Number(mediaId), withCustomBigData: false, forceMetadataForLinks: true, integerCoords: false
        }, apiHeaders);
        annotation = annotationInfo?.annotation;
        if (!annotation || typeof annotation !== 'object') {
          return response({ error: 'Supervisely returned image details but no saved annotation JSON.' }, 502, cors);
        }
        mime = String(info.mime || 'image/jpeg').toLowerCase();
        if (!new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']).has(mime)) {
          return response({ error: 'The selected source image format is not supported for review.' }, 415, cors);
        }
        const download = await fetch(SUPERVISELY_API + '/images.download', {
          method: 'POST', headers: apiHeaders, body: JSON.stringify({ id: Number(mediaId) })
        });
        if (!download.ok) throw new Error(`Supervisely image download failed (${download.status}).`);
        bytes = new Uint8Array(await download.arrayBuffer());
        name = safeName(info.name, `image-${mediaId}`);
        width = Number(info.width) || Number(annotation.size?.width) || null;
        height = Number(info.height) || Number(annotation.size?.height) || null;
        annotationCreatedAt = annotationInfo.createdAt || null;
        annotationUpdatedAt = annotationInfo.updatedAt || info.updatedAt || null;
      } else if (mediaType === 'video') {
        info = await supervisely('videos.info', { id: Number(mediaId), forceMetadataForLinks: true }, apiHeaders);
        if (String(info.datasetId) !== datasetId || String(info.projectId) !== externalProjectId) {
          return response({ error: 'The selected video does not belong to the supplied Supervisely dataset/project.' }, 409, cors);
        }
        const annotationList = await supervisely('videos.annotations.bulk.info', {
          videoIds: [Number(mediaId)], forceMetadataForLinks: true, integerCoords: false
        }, apiHeaders);
        annotation = Array.isArray(annotationList) ? annotationList[0] : annotationList;
        if (!annotation || typeof annotation !== 'object' || !Array.isArray(annotation.frames)) {
          return response({ error: 'Supervisely returned video details but no saved frame annotations.' }, 502, cors);
        }
        const download = await fetch(SUPERVISELY_API + '/videos.download', {
          method: 'POST', headers: apiHeaders, body: JSON.stringify({ id: Number(mediaId) })
        });
        if (!download.ok) throw new Error(`Supervisely video download failed (${download.status}).`);
        bytes = new Uint8Array(await download.arrayBuffer());
        name = safeName(info.name, `video-${mediaId}.mp4`);
        mime = String(info.fileMeta?.mime || info.mime || 'video/mp4').toLowerCase();
        if (!new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']).has(mime)) {
          return response({ error: 'The selected video format is not supported for review.' }, 415, cors);
        }
        width = Number(info.fileMeta?.width || info.frameWidth) || Number(annotation.size?.width) || null;
        height = Number(info.fileMeta?.height || info.frameHeight) || Number(annotation.size?.height) || null;
        annotationCreatedAt = annotation.createdAt || null;
        annotationUpdatedAt = annotation.updatedAt || info.updatedAt || null;
      } else {
        info = await supervisely('point-clouds.info', { id: Number(mediaId) }, apiHeaders);
        if (String(info.datasetId) !== datasetId || String(info.projectId) !== externalProjectId) {
          return response({ error: 'The selected point cloud does not belong to the supplied dataset/project.' }, 409, cors);
        }
        const annotationList = await supervisely('point-clouds.annotations.bulk.info', { pointcloudIds: [Number(mediaId)] }, apiHeaders);
        annotation = Array.isArray(annotationList) ? annotationList[0] : annotationList;
        if (!annotation || typeof annotation !== 'object') {
          return response({ error: 'Supervisely returned no point-cloud annotation.' }, 502, cors);
        }
        const download = await fetch(SUPERVISELY_API + '/point-clouds.download', {
          method: 'POST', headers: apiHeaders, body: JSON.stringify({ id: Number(mediaId) })
        });
        if (!download.ok) throw new Error(`Supervisely point-cloud download failed (${download.status}).`);
        bytes = new Uint8Array(await download.arrayBuffer());
        name = safeName(info.name, `pointcloud-${mediaId}`);
        mime = info.cloudMime || 'application/octet-stream';
      }

      if (!bytes?.length || bytes.length > 100 * 1024 * 1024) {
        return response({ error: 'The source media is empty or exceeds the 100 MB review limit.' }, 413, cors);
      }
      const storageKey = `${body.project_id}/supervisely-${mediaType}-${mediaId}-${name}`;
      const upload = await fetch(sign('PUT', storageKey, mime, 600), {
        method: 'PUT', headers: { 'Content-Type': mime }, body: bytes
      });
      if (!upload.ok) throw new Error(`Neon Object Storage upload failed (${upload.status}).`);

      const record = {
        project_id: body.project_id,
        assignment_id: assignment.id,
        external_platform: 'supervisely',
        external_project_id: externalProjectId,
        external_dataset_id: datasetId,
        external_image_id: mediaId,
        image_name: name,
        image_mime_type: mime,
        media_type: mediaType,
        image_storage_path: storageKey,
        image_width: width,
        image_height: height,
        annotation_json: annotation,
        annotation_created_at: annotationCreatedAt,
        annotation_updated_at: annotationUpdatedAt,
        label_count: countLabels(annotation),
        imported_by: claims.sub,
        imported_at: new Date().toISOString()
      };
      const saved = await db('/project_annotations?on_conflict=assignment_id,external_platform,external_image_id', token, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(record)
      });
      const updated = await db(
        `/project_assignments?id=eq.${encode(assignment.id)}&annotator_user_id=eq.${encode(claims.sub)}&assignment_status=in.(in_progress,rework)`,
        token,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ assignment_status: 'submitted' }) }
      );
      if (!updated?.length) {
        return response({ error: 'The annotation was imported, but assignment status changed. Contact Savannah support.' }, 409, cors);
      }
      return response({
        success: true, annotation: saved?.[0] || saved, assignment: updated[0],
        message: mediaType === 'image' ? 'Image and annotation submitted for review.' : mediaType === 'video' ? 'Video and frame annotations submitted for review.' : 'Point cloud and annotation submitted for review.'
      }, 200, cors);
    } catch (error) {
      console.error('Savannah Supervisely review error:', error);
      return response({ error: error?.message || 'Supervisely submission failed.' }, 500, cors);
    }
  }
};
