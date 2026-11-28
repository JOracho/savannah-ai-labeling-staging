import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = "client-project-uploads";
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;
const MAX_FILES = 10;
const ORIGINS = new Set(["https://joracho.github.io", "http://localhost:3000", "http://127.0.0.1:5500"]);
const MIME = { zip:"application/zip", tar:"application/x-tar", gz:"application/gzip", pcd:"application/octet-stream", bin:"application/octet-stream", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", mp4:"video/mp4", json:"application/json", csv:"text/csv", pdf:"application/pdf", txt:"text/plain" };
const s3 = new S3Client({ forcePathStyle: true });
const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cors(origin) {
  return { "Access-Control-Allow-Origin": ORIGINS.has(origin) ? origin : "https://joracho.github.io", "Access-Control-Allow-Headers":"authorization,content-type", "Access-Control-Allow-Methods":"POST,OPTIONS", "Vary":"Origin" };
}
function json(body,status,headers) { return new Response(JSON.stringify(body), { status, headers:{...headers,"Content-Type":"application/json"} }); }
function claims(token) {
  const p=token.split(".");
  if(p.length!==3) throw new Error("Invalid bearer token.");
  const raw=p[1].replace(/-/g,"+").replace(/_/g,"/");
  return JSON.parse(atob(raw+"=".repeat((4-raw.length%4)%4)));
}
async function db(path,token,options={}) {
  const base=process.env.NEON_DATA_API_URL;
  if(!base) throw new Error("Savannah database API is not configured.");
  const res=await fetch(base.replace(/\/$/,"")+path,{...options,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",...(options.headers||{})}});
  const raw=await res.text(); let data=null;
  try { data=raw?JSON.parse(raw):null; } catch { data={message:raw}; }
  if(!res.ok) throw new Error(data?.message||data?.details||data?.hint||"Database request failed ("+res.status+").");
  return data;
}
async function profile(token,id) {
  const rows=await db("/profiles?select=id,email,role&id=eq."+enc(id)+"&limit=1",token);
  return rows?.[0]||null;
}
function fileMeta(f) {
  const name=String(f.name||"").trim().slice(0,255);
  const size=Number(f.size);
  const lower=name.toLowerCase();
  const ext=lower.endsWith(".tar.gz")?"gz":lower.split(".").pop();
  const mime=MIME[ext]||String(f.type||"application/octet-stream");
  const accepted=["zip","tar","gz","pcd","bin","png","jpg","jpeg","webp","mp4","json","csv","pdf","txt"];
  if(!name || !accepted.some(x=>lower.endsWith("."+x))) throw new Error("Unsupported file type: "+name);
  if(!Number.isSafeInteger(size)||size<1||size>MAX_FILE) throw new Error("Each file must be between 1 byte and 50 MB.");
  const safe=name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g,"_").replace(/^\.+/,"").slice(-140)||"client-file";
  return {name,size,mime,safe};
}

export default {
  async fetch(request) {
    const headers=cors(request.headers.get("origin")||"");
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers});
    if(request.method!=="POST") return json({error:"Method not allowed."},405,headers);
    const auth=request.headers.get("authorization")||"";
    if(!/^Bearer\s+/i.test(auth)) return json({error:"Sign in is required."},401,headers);
    const token=auth.replace(/^Bearer\s+/i,"").trim();
    try {
      const c=claims(token);
      if(!UUID.test(String(c.sub||""))) return json({error:"Invalid session."},401,headers);
      const me=await profile(token,c.sub);
      if(!me) return json({error:"Create your Savannah profile first."},403,headers);
      const body=await request.json().catch(()=>({}));
      const action=body.action;

      if(action==="client_upload_intent") {
        if(me.role!=="client") return json({error:"Client access is required."},403,headers);
        const requestId=String(body.project_request_id||"");
        if(!UUID.test(requestId)||!Array.isArray(body.files)||body.files.length<1||body.files.length>MAX_FILES)
          return json({error:"Provide a valid project request and between 1 and 10 files."},400,headers);
        const owned=await db("/project_requests?select=id,submitted_by&id=eq."+enc(requestId)+"&submitted_by=eq."+enc(c.sub)+"&limit=1",token);
        if(!owned.length) return json({error:"Project request not found for this client account."},404,headers);
        const files=body.files.map(fileMeta);
        const total=files.reduce((n,f)=>n+f.size,0);
        if(total>MAX_TOTAL) return json({error:"Combined upload must be 150 MB or smaller."},413,headers);
        const rows=files.map(f=>({project_request_id:requestId,uploaded_by:c.sub,file_name:f.name,storage_path:"client-requests/"+requestId+"/"+crypto.randomUUID()+"-"+f.safe,mime_type:f.mime,file_size_bytes:f.size,upload_status:"pending"}));
        await db("/project_request_files",token,{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify(rows)});
        const uploads=[];
        for(let i=0;i<rows.length;i++) {
          const row=rows[i],f=files[i];
          const upload_url=await getSignedUrl(s3,new PutObjectCommand({Bucket:BUCKET,Key:row.storage_path,ContentType:f.mime}),{expiresIn:600});
          uploads.push({id:row.id||null,storage_path:row.storage_path,upload_url,method:"PUT",headers:{"Content-Type":f.mime}});
        }
        // Retrieve inserted rows to return their generated IDs in request order.
        const saved=await db("/project_request_files?select=id,storage_path&project_request_id=eq."+enc(requestId)+"&uploaded_by=eq."+enc(c.sub)+"&upload_status=eq.pending&order=created_at.desc&limit="+files.length,token);
        const byPath=new Map(saved.map(x=>[x.storage_path,x.id]));
        for(const item of uploads) item.id=byPath.get(item.storage_path);
        if(uploads.some(x=>!x.id)) throw new Error("Could not verify the pending file records. Please retry.");
        return json({success:true,files:uploads},200,headers);
      }

      if(action==="client_finalize_upload") {
        if(me.role!=="client"||!Array.isArray(body.file_ids)||!body.file_ids.length||body.file_ids.length>MAX_FILES||body.file_ids.some(x=>!UUID.test(String(x))))
          return json({error:"Invalid client file verification request."},400,headers);
        const ids=body.file_ids.map(enc).join(",");
        const rows=await db("/project_request_files?select=id,storage_path,file_size_bytes,mime_type,upload_status&id=in.("+ids+")&uploaded_by=eq."+enc(c.sub),token);
        if(rows.length!==body.file_ids.length) return json({error:"One or more uploaded files could not be found for this client."},404,headers);
        for(const row of rows) {
          if(row.upload_status!=="pending") continue;
          const url=await getSignedUrl(s3,new HeadObjectCommand({Bucket:BUCKET,Key:row.storage_path}),{expiresIn:60});
          const head=await fetch(url,{method:"HEAD"});
          if(!head.ok||Number(head.headers.get("content-length"))!==Number(row.file_size_bytes))
            return json({error:"A file is missing or its size does not match. Please upload it again."},409,headers);
        }
        await db("/project_request_files?id=in.("+ids+")&uploaded_by=eq."+enc(c.sub),token,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({upload_status:"received"})});
        return json({success:true,message:"Files uploaded and verified."},200,headers);
      }

      if(action==="admin_list_client_files") {
        if(!["admin","reviewer"].includes(me.role)) return json({error:"Administrator or reviewer access is required."},403,headers);
        const rows=await db("/project_request_files?select=id,project_request_id,uploaded_by,file_name,storage_path,mime_type,file_size_bytes,upload_status,created_at,project_requests(project_title,contact_name,contact_email)&order=created_at.desc&limit=500",token);
        const files=[];
        for(const row of rows) {
          const download_url=row.upload_status==="received" ? await getSignedUrl(s3,new GetObjectCommand({Bucket:BUCKET,Key:row.storage_path}),{expiresIn:300}) : null;
          files.push({id:row.id,project_request_id:row.project_request_id,file_name:row.file_name,storage_path:row.storage_path,mime_type:row.mime_type,file_size_bytes:row.file_size_bytes,upload_status:row.upload_status,created_at:row.created_at,project:row.project_requests||{},download_url});
        }
        return json({success:true,files},200,headers);
      }
      return json({error:"Unknown client upload action."},400,headers);
    } catch(error) {
      console.error("clientuploads error:",error);
      return json({error:error?.message||"Client file service failed."},500,headers);
    }
  }
};