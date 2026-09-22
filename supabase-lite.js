/* VibeNest — lightweight Supabase client for plain HTML */
(function(){
  "use strict";

  const config = window.VIBENEST_CONFIG;
  if(!config?.supabaseUrl || !config?.supabasePublishableKey){
    throw new Error("Falta la configuración de Supabase.");
  }

  const SUPABASE_URL = config.supabaseUrl.replace(/\/$/,"");
  const API_KEY = config.supabasePublishableKey;
  const SESSION_KEY = "vibenest_session_v1";
  const listeners = new Set();
  let refreshTimer = null;

  function authHeaders(accessToken){
    const h = { "apikey": API_KEY, "Content-Type": "application/json" };
    if(accessToken) h.Authorization = "Bearer " + accessToken;
    return h;
  }

  async function parseResponse(res){
    const text = await res.text();
    let data = null;
    if(text){
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    if(!res.ok){
      const message = data?.msg || data?.message || data?.error_description || data?.error || (typeof data === "string" ? data : ("HTTP " + res.status));
      const error = new Error(message);
      error.status = res.status;
      error.code = data?.code || data?.error_code || "";
      return { data: null, error };
    }
    return { data, error: null };
  }

  function emit(event, session){
    listeners.forEach(fn => {
      try { fn(event, session); } catch(err){ console.error("VibeNest auth listener:", err); }
    });
  }

  function saveSession(session){
    if(session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  function readSession(){
    try{
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch{
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function refreshSession(session){
    if(!session?.refresh_token) return null;
    const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token",{
      method:"POST",
      headers:authHeaders(),
      body:JSON.stringify({refresh_token:session.refresh_token})
    });
    const out = await parseResponse(res);
    if(out.error) return null;
    saveSession(out.data);
    return out.data;
  }

  function scheduleRefresh(session){
    if(refreshTimer) clearTimeout(refreshTimer);
    if(!session?.expires_at) return;
    const expiresAt = Number(session.expires_at) * 1000;
    const delay = Math.max(30000, expiresAt - Date.now() - 60000);
    refreshTimer = setTimeout(async()=>{
      const current = readSession();
      const next = await refreshSession(current);
      if(next) emit("TOKEN_REFRESHED", next);
      scheduleRefresh(next || current);
    }, delay);
  }

  class QueryBuilder{
    constructor(client, table){
      this.client = client;
      this.table = table;
      this.method = "GET";
      this.params = new URLSearchParams();
      this.headers = {};
      this.body = null;
      this.wantSingle = false;
      this.singleLimit = false;
    }
    select(columns="*", options={}){
      this.params.set("select", columns);
      if(options.count === "exact") this.headers.Prefer = "count=exact";
      if(options.head) {
        this.method = "HEAD";
        this.headers.Prefer = "count=exact";
      }
      return this;
    }
    eq(column, value){ this.params.set(column, "eq." + String(value)); return this; }
    ilike(column, value){ this.params.set(column, "ilike." + String(value)); return this; }
    in(column, values){
      const list = Array.isArray(values) ? values : [values];
      this.params.set(column, "in.(" + list.map(v=>String(v).replace(/[(),]/g,"")).join(",") + ")");
      return this;
    }
    order(column, opts={}){
      this.params.set("order", column + "." + (opts.ascending === false ? "desc" : "asc"));
      return this;
    }
    limit(value){ this.params.set("limit", String(value)); return this; }
    insert(value){
      this.method = "POST";
      this.body = value;
      this.headers.Prefer = "return=representation";
      return this;
    }
    update(value){
      this.method = "PATCH";
      this.body = value;
      this.headers.Prefer = "return=representation";
      return this;
    }
    delete(){
      this.method = "DELETE";
      return this;
    }
    maybeSingle(){
      this.wantSingle = true;
      this.params.set("limit", "1");
      return this;
    }
    async execute(){
      const token = this.client._getAccessToken();
      const url = SUPABASE_URL + "/rest/v1/" + encodeURIComponent(this.table) + (this.params.toString() ? "?" + this.params.toString() : "");
      const headers = {...authHeaders(token), ...this.headers};
      let body = this.body;
      if(this.method === "POST" || this.method === "PATCH") headers["Content-Type"] = "application/json";
      const res = await fetch(url,{
        method:this.method,
        headers,
        body: body == null ? undefined : JSON.stringify(body)
      });
      const out = await parseResponse(res);
      if(out.error) return out;

      if(this.method === "HEAD"){
        const range = res.headers.get("content-range") || "";
        const totalPart = range.split("/")[1];
        return {data:null,error:null,count: totalPart && totalPart !== "*" ? Number(totalPart) : 0};
      }

      let data = out.data;
      if(this.wantSingle){
        data = Array.isArray(data) ? (data[0] ?? null) : data;
      }
      return {data,error:null,count:Array.isArray(data) ? data.length : undefined};
    }
    then(resolve,reject){ return this.execute().then(resolve,reject); }
    catch(reject){ return this.execute().catch(reject); }
  }

  class StorageBucket{
    constructor(client,bucket){ this.client=client; this.bucket=bucket; }
    async upload(path,file,options={}){
      const token=this.client._getAccessToken();
      const url=SUPABASE_URL+"/storage/v1/object/"+encodeURIComponent(this.bucket)+"/"+path.split("/").map(encodeURIComponent).join("/");
      const headers={...authHeaders(token),"Content-Type":file.type||"application/octet-stream","x-upsert":String(!!options.upsert)};
      headers["cache-control"]=options.cacheControl || "3600";
      const res=await fetch(url,{method:"POST",headers,body:file});
      return parseResponse(res);
    }
    getPublicUrl(path){
      return {data:{publicUrl:SUPABASE_URL+"/storage/v1/object/public/"+encodeURIComponent(this.bucket)+"/"+path.split("/").map(encodeURIComponent).join("/")}};
    }
    async remove(paths){
      const token=this.client._getAccessToken();
      const url=SUPABASE_URL+"/storage/v1/object/"+encodeURIComponent(this.bucket);
      const res=await fetch(url,{method:"DELETE",headers:authHeaders(token),body:JSON.stringify({prefixes:paths})});
      return parseResponse(res);
    }
  }

  class Client{
    constructor(){
      this.auth={
        getSession: async()=>{
          let session=readSession();
          if(session?.expires_at && Number(session.expires_at)*1000 < Date.now()+30000){
            const fresh=await refreshSession(session);
            if(fresh){ session=fresh; emit("TOKEN_REFRESHED",session); }
            else { saveSession(null); session=null; }
          }
          scheduleRefresh(session);
          return {data:{session},error:null};
        },
        onAuthStateChange: (callback)=>{
          listeners.add(callback);
          return {data:{subscription:{unsubscribe:()=>listeners.delete(callback)}}};
        },
        signUp: async({email,password,options={}})=>{
          const payload={email,password};
          if(options.data) payload.data=options.data;
          if(options.emailRedirectTo) payload.redirect_to=options.emailRedirectTo;
          const res=await fetch(SUPABASE_URL+"/auth/v1/signup",{
            method:"POST",headers:authHeaders(),body:JSON.stringify(payload)
          });
          const out=await parseResponse(res);
          if(out.error)return out;
          const data={
            user:out.data?.user || out.data,
            session:out.data?.session || null
          };
          if(data.session){ saveSession(data.session); scheduleRefresh(data.session); emit("SIGNED_IN",data.session); }
          return {data,error:null};
        },
        signInWithPassword: async({email,password})=>{
          const res=await fetch(SUPABASE_URL+"/auth/v1/token?grant_type=password",{
            method:"POST",headers:authHeaders(),body:JSON.stringify({email,password})
          });
          const out=await parseResponse(res);
          if(out.error)return out;
          saveSession(out.data);
          scheduleRefresh(out.data);
          emit("SIGNED_IN",out.data);
          return {data:{session:out.data,user:out.data?.user},error:null};
        },
        signOut: async()=>{
          const token=this._getAccessToken();
          let error=null;
          if(token){
            const res=await fetch(SUPABASE_URL+"/auth/v1/logout",{
              method:"POST",headers:authHeaders(token)
            });
            const out=await parseResponse(res);
            error=out.error;
          }
          if(refreshTimer)clearTimeout(refreshTimer);
          saveSession(null);
          emit("SIGNED_OUT",null);
          return {error};
        }
      };
    }
    _getAccessToken(){
      return readSession()?.access_token || null;
    }
    from(table){ return new QueryBuilder(this,table); }
    storage={from:(bucket)=>new StorageBucket(this,bucket)};
  }

  window.supabase={createClient:()=>new Client()};
})();
