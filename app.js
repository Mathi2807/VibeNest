const {createClient}=window.supabase;
const supabase=createClient(window.VIBENEST_CONFIG.supabaseUrl,window.VIBENEST_CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});

let session=null;
let currentProfile=null;
let currentNav="feed";
let authMode="login";
let feedMode="forYou";
let profileTab="posts";
let currentChatUser=null;
let currentGroup=null;
let toastTimer=null;
let liveTimer=null;
let searchTimer=null;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

function toast(msg){
  const e=$("#toast");
  if(!e)return;
  e.textContent=msg;
  e.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>e.classList.remove("show"),3400);
}

function esc(v=""){
  return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function initials(p){
  return esc((p?.display_name||p?.username||"?").trim().slice(0,1).toUpperCase());
}

function avatar(p,small=false){
  const cls="avatar"+(small?" small":"");
  if(p?.avatar_url)return '<img class="'+cls+'" src="'+esc(p.avatar_url)+'" alt="">';
  return '<div class="'+cls+'">'+initials(p)+'</div>';
}

function formatCount(n){
  n=Number(n||0);
  if(n<1000)return String(n);
  if(n<1000000)return (n/1000).toFixed(n<10000?1:0).replace(".0","")+"k";
  return (n/1000000).toFixed(1).replace(".0","")+"M";
}

function timeAgo(d){
  const n=Math.max(0,Math.floor((Date.now()-new Date(d))/1000));
  if(n<45)return"ahora";
  if(n<3600)return Math.floor(n/60)+" min";
  if(n<86400)return Math.floor(n/3600)+" h";
  if(n<604800)return Math.floor(n/86400)+" d";
  return new Date(d).toLocaleDateString("es-CR",{day:"numeric",month:"short"});
}

function safeName(name){
  return String(name||"archivo").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-90);
}

function idsOrPlaceholder(ids){
  return ids.length?ids:["00000000-0000-0000-0000-000000000000"];
}

async function profilesByIds(ids){
  const clean=[...new Set((ids||[]).filter(Boolean))];
  if(!clean.length)return[];
  const r=await supabase.from("profiles").select("*").in("id",clean);
  return r.error?[]:(r.data||[]);
}

async function profileById(id){
  const {data,error}=await supabase.from("profiles").select("*").eq("id",id).maybeSingle();
  if(error)throw error;
  return data;
}

async function currentBlockIds(){
  if(!session)return new Set();
  const r=await supabase.from("blocks").select("blocked_id").eq("blocker_id",session.user.id);
  return new Set((r.data||[]).map(x=>x.blocked_id));
}

function renderRichText(text){
  const safe=esc(text||"");
  return safe.replace(/(^|[\s])(#([a-zA-Z0-9_]{1,40}))/g,(m,pre,tag)=>pre+'<button class="hashtag" data-hashtag="'+esc(tag.slice(1).toLowerCase())+'">'+tag+'</button>');
}

function authErrorMessage(error){
  const code=error?.code||error?.name||"";
  const msg=error?.message||"Error desconocido.";
  if(code==="invalid_credentials")return"Correo o contraseña incorrectos.";
  if(code==="email_not_confirmed")return"Este correo todavía no está confirmado.";
  if(code==="user_already_exists")return"Ya existe una cuenta con ese correo.";
  if(code==="weak_password")return"La contraseña no cumple los requisitos.";
  if(code==="over_email_send_rate_limit")return"Demasiados intentos. Espera un momento.";
  if(code==="email_provider_disabled")return"El acceso por correo está desactivado.";
  return msg;
}

function showAuthError(error){
  console.error("VibeNest Auth:",error);
  toast(authErrorMessage(error));
}

async function uploadMedia(file,folder,limitMB){
  if(!file)throw new Error("No elegiste ningún archivo.");
  const image=/^image\/(png|jpe?g|gif|webp)$/i.test(file.type);
  const video=/^video\/(mp4|webm|ogg)$/i.test(file.type);
  if(!image&&!video)throw new Error("Solo se permiten imágenes PNG/JPG/GIF/WebP y videos MP4/WebM/OGG.");
  if(file.size>limitMB*1024*1024)throw new Error("El archivo supera el límite de "+limitMB+" MB.");
  const path=session.user.id+"/"+folder+"/"+crypto.randomUUID()+"-"+safeName(file.name);
  const up=await supabase.storage.from("media").upload(path,file,{upsert:false,contentType:file.type});
  if(up.error)throw up.error;
  return{path,url:supabase.storage.from("media").getPublicUrl(path).data.publicUrl,type:video?"video":"image"};
}

async function refreshNotifCount(){
  if(!session)return;
  const [n,m]=await Promise.all([
    supabase.from("notifications").select("id",{count:"exact",head:true}).eq("recipient_id",session.user.id).eq("read",false).neq("type","message"),
    supabase.from("messages").select("id",{count:"exact",head:true}).eq("recipient_id",session.user.id).is("read_at",null)
  ]);
  const notifCount=n.count||0;
  const messageCount=m.count||0;
  const e=$("#notifCount"),dot=$("#messageDot");
  if(e){e.textContent=notifCount?formatCount(notifCount):"";e.style.display=notifCount?"inline-grid":"none"}
  if(dot)dot.style.display=messageCount?"block":"none";
}

function setTheme(mode){
  const resolved=mode==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):mode;
  document.body.classList.toggle("dark",resolved==="dark");
  document.documentElement.dataset.theme=resolved;
  localStorage.vibeTheme=mode;
  const btn=$("#themeBtn");
  if(btn)btn.textContent=resolved==="dark"?"☀":"☾";
}

function initTheme(){
  setTheme(localStorage.vibeTheme||"system");
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>{
    if((localStorage.vibeTheme||"system")==="system")setTheme("system");
  });
}

async function ensureProfile(s){
  let p=await profileById(s.user.id);
  if(p)return p;
  let pending=null;
  try{pending=JSON.parse(localStorage.getItem("vibenest_pending_profile")||"null")}catch{}
  const email=s.user.email||"user";
  const base=email.split("@")[0].replace(/[^A-Za-z0-9_]/g,"").slice(0,18)||"user";
  const username=(pending?.email===email&&pending.username)?pending.username:(base+"_"+Math.floor(Math.random()*900+100)).slice(0,24);
  const display=(pending?.email===email&&pending.displayName)?pending.displayName:base;
  let ins=await supabase.from("profiles").insert({id:s.user.id,username,display_name:display});
  if(ins.error&&ins.error.code==="23505")ins=await supabase.from("profiles").insert({id:s.user.id,username:(base+"_"+Date.now()).slice(0,24),display_name:display});
  localStorage.removeItem("vibenest_pending_profile");
  if(ins.error)throw ins.error;
  return await profileById(s.user.id);
}

async function boot(){
  try{
    initTheme();
    const r=await supabase.auth.getSession();
    if(r.error)throw r.error;
    await handleSession(r.data.session);
    supabase.auth.onAuthStateChange((_event,s)=>handleSession(s).catch(showAuthError));
  }catch(err){showAuthError(err)}
}

async function handleSession(s){
  session=s;
  if(!s){
    currentProfile=null;currentChatUser=null;stopLiveRefresh();
    $("#authView").classList.remove("hidden");$("#appView").classList.add("hidden");return;
  }
  currentProfile=await ensureProfile(s);
  $("#authView").classList.add("hidden");$("#appView").classList.remove("hidden");
  renderMini();await refreshNotifCount();await navigate(currentNav);
}

function renderMini(){
  const p=currentProfile;
  $("#miniProfile").innerHTML='<button class="mini-profile" data-profile="'+esc(p.id)+'">'+avatar(p,true)+'<span><b>'+esc(p.display_name)+'</b><small>@'+esc(p.username)+'</small></span></button>';
}

function stopLiveRefresh(){
  if(liveTimer)clearInterval(liveTimer);
  liveTimer=null;
}

function startLiveRefresh(){
  stopLiveRefresh();
  if(currentNav==="messages"||currentNav==="groups"){
    liveTimer=setInterval(()=>{
      if(currentNav==="messages"){
        if(currentChatUser)refreshConversation(false);
        else renderMessages(false);
      }else if(currentNav==="groups"&&currentGroup)refreshGroupChat(false);
      refreshNotifCount();
    },3000);
  }
}

async function navigate(n){
  currentNav=n;
  $$(".nav-item,.top-nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.nav===n));
  stopLiveRefresh();
  if(n==="feed")await renderFeed();
  else if(n==="explore")await renderExplore();
  else if(n==="saved")await renderSaved();
  else if(n==="messages")await renderMessages(true);
  else if(n==="notifications")await renderNotifications();
  else if(n==="profile")await renderProfile(currentProfile.id);
  else if(n==="settings")await renderSettings();
  else if(n==="groups")await renderGroups();
  startLiveRefresh();
}

function pageHeader(title,subtitle,actions=""){
  return'<div class="page-head"><div><h1>'+esc(title)+'</h1><p>'+esc(subtitle)+'</p></div><div class="page-head-actions">'+actions+'</div></div>';
}

function storyStrip(stories,profiles){
  const m=Object.fromEntries(profiles.map(p=>[p.id,p]));
  const grouped=new Map();
  for(const s of stories||[]){if(!grouped.has(s.user_id))grouped.set(s.user_id,[]);grouped.get(s.user_id).push(s)}
  let html='<div class="stories card"><div class="stories-head"><b>Stories</b><button class="link-btn" id="addStoryBtn">+ Crear story</button></div><div class="story-row"><button class="story-create" id="addStoryBtn2"><span>＋</span><small>Tu story</small></button>';
  grouped.forEach((arr,userId)=>{
    const p=m[userId];if(!p)return;
    html+='<button class="story-user" data-story-user="'+userId+'"><span class="story-ring">'+avatar(p)+'</span><small>'+esc(p.display_name||p.username)+'</small></button>';
  });
  return html+'</div></div>';
}

async function fetchStories(){
  const r=await supabase.from("stories").select("*").order("created_at",{ascending:false}).limit(80);
  if(r.error)return{stories:[],profiles:[]};
  const active=(r.data||[]).filter(s=>new Date(s.expires_at)>new Date());
  return{stories:active,profiles:await profilesByIds(active.map(s=>s.user_id))};
}

function composer(){
  return'<div class="card composer"><div class="composer-head">'+avatar(currentProfile,true)+'<div><b>'+esc(currentProfile.display_name)+'</b><small> Comparte algo con tu red</small></div></div><textarea id="postText" maxlength="2200" placeholder="¿Qué está pasando? Usa #hashtags o crea una encuesta."></textarea><div id="pollComposer" class="poll-composer hidden"><input id="pollQuestion" maxlength="200" placeholder="Pregunta de la encuesta…"><div id="pollOptions"><input class="poll-option-input" maxlength="80" placeholder="Opción 1"><input class="poll-option-input" maxlength="80" placeholder="Opción 2"></div><button class="text-btn" id="addPollOption">+ Añadir opción</button></div><div class="composer-preview hidden" id="mediaPreview"></div><div class="composer-actions"><div class="composer-tools"><label class="tool-btn">📎 Foto/video<input id="mediaInput" type="file" accept="image/*,video/*" hidden></label><button class="tool-btn" id="pollToggle">📊 Encuesta</button></div><button class="primary" id="postBtn">Publicar</button></div><small id="fileName" class="muted"></small></div>';
}

async function renderFeed(){
  const c=$("#content");
  const stories=await fetchStories();
  let followingIds=[];
  if(feedMode==="following"){
    const f=await supabase.from("follows").select("following_id").eq("follower_id",session.user.id);
    followingIds=(f.data||[]).map(x=>x.following_id);
  }
  let query=supabase.from("posts").select("*").order("created_at",{ascending:false}).limit(70);
  if(feedMode==="following")query=followingIds.length?query.in("user_id",[session.user.id,...followingIds]):query.eq("user_id",session.user.id);
  const r=await query;
  if(r.error){
    c.innerHTML=pageHeader("Inicio","Tu feed")+'<div class="card empty">No se pudo cargar el feed.</div>';
    return toast(r.error.message);
  }
  const blocked=await currentBlockIds();
  const rawPosts=(r.data||[]).filter(p=>!blocked.has(p.user_id));
  const profiles=await profilesByIds(rawPosts.map(p=>p.user_id));
  const profileMap=Object.fromEntries(profiles.map(p=>[p.id,p]));
  const allowedFollowing=new Set(followingIds);
  const posts=rawPosts.filter(p=>{
    const author=profileMap[p.user_id];
    return author?.profile_visibility!=="private" || p.user_id===session.user.id || allowedFollowing.has(p.user_id);
  });
  const meta=await loadPostMeta(posts.map(p=>p.id));
  c.innerHTML=pageHeader("Inicio","Tu rincón para compartir vibes.",'<button class="seg '+(feedMode==="forYou"?"active":"")+'" data-feedmode="forYou">Para ti</button><button class="seg '+(feedMode==="following"?"active":"")+'" data-feedmode="following">Siguiendo</button>')+storyStrip(stories.stories,stories.profiles)+composer()+'<div id="feedList">'+(posts.map(p=>postHtml(p,profiles.find(x=>x.id===p.user_id),meta[p.id])).join("")||'<div class="card empty">Todavía no hay publicaciones. Sé el primero. 🚀</div>')+'</div>';
  bindFeedControls();bindPostEvents();
}

function postHtml(p,u,meta={}){
  const likeCount=meta.likeCount||0,commentCount=meta.commentCount||0,repostCount=meta.repostCount||0,reactionCount=meta.reactionCount||0;
  const poll=meta.poll,edited=p.edited_at?" · editado":"",isMine=p.user_id===session.user.id;
  const reactions=meta.reactions||{},reactionLabels={fire:"🔥",laugh:"😂",wow:"😮",sad:"😢",party:"🎉"};
  let reactionSummary="";
  Object.keys(reactions).forEach(k=>{if(reactions[k])reactionSummary+=reactionLabels[k]+formatCount(reactions[k])+" "});
  const media=p.media_url?(p.media_type==="video"?'<video class="post-media" controls preload="metadata" src="'+esc(p.media_url)+'"></video>':'<img class="post-media" loading="lazy" src="'+esc(p.media_url)+'" alt="Publicación">'):"";
  return'<article class="card post" data-post="'+p.id+'"><div class="post-head"><button class="profile-link" data-profile="'+esc(u?.id||p.user_id)+'">'+avatar(u,true)+'</button><div class="post-author"><button class="plain-link" data-profile="'+esc(u?.id||p.user_id)+'">'+esc(u?.display_name||"Usuario")+'</button><small>@'+esc(u?.username||"user")+' · '+timeAgo(p.created_at)+esc(edited)+'</small></div><div class="post-menu"><button class="icon-btn" data-menu="'+p.id+'">•••</button><div class="post-menu-pop hidden" id="menu-'+p.id+'">'+(isMine?'<button data-edit="'+p.id+'">✏️ Editar</button><button class="danger-text" data-delete="'+p.id+'">🗑️ Eliminar</button>':'<button data-report="'+p.id+'">🚩 Reportar</button><button data-block="'+p.user_id+'">⛔ Bloquear</button>')+'</div></div></div>'+(p.content?'<div class="post-content">'+renderRichText(p.content)+'</div>':"")+media+(poll?pollHtmlView(p):"")+'<div class="post-summary"><span>'+formatCount(likeCount)+' me gusta</span><span>'+formatCount(commentCount)+' comentarios</span><span>'+formatCount(repostCount)+' reposts</span>'+(reactionSummary?'<span>'+reactionSummary+'</span>':"")+'</div><div class="post-actions"><button class="'+(meta.liked?"liked":"")+'" data-like="'+p.id+'">♥ <span>'+formatCount(likeCount)+'</span></button><button data-reaction-toggle="'+p.id+'">✨ Reaccionar'+(meta.myReaction?" "+reactionLabels[meta.myReaction]:"")+'</button><button data-comments="'+p.id+'">💬</button><button class="'+(meta.saved?"saved":"")+'" data-save="'+p.id+'">🔖</button><button class="'+(meta.reposted?"reposted":"")+'" data-repost="'+p.id+'">🔁</button></div><div class="reaction-picker hidden" id="reaction-'+p.id+'"><button data-reaction="fire" data-post="'+p.id+'">🔥</button><button data-reaction="laugh" data-post="'+p.id+'">😂</button><button data-reaction="wow" data-post="'+p.id+'">😮</button><button data-reaction="sad" data-post="'+p.id+'">😢</button><button data-reaction="party" data-post="'+p.id+'">🎉</button></div><div class="comments" id="comments-'+p.id+'"></div></article>';
}

function pollHtmlView(poll){
  const total=poll.total||0;
  let html='<div class="poll-card"><b>📊 '+esc(poll.question)+'</b><div class="poll-options">';
  for(const o of poll.options||[]){
    const count=poll.votesByOption?.[o.id]||0,pct=total?Math.round(count*100/total):0;
    html+='<button class="poll-option '+(poll.myVote===o.id?"chosen":"")+'" data-vote="'+o.id+'" data-poll="'+poll.id+'"><span>'+esc(o.label)+'</span><span>'+pct+'%</span><i style="width:'+pct+'%"></i></button>';
  }
  return html+'</div><small class="muted">'+formatCount(total)+' voto'+(total===1?"":"s")+(poll.myVote?" · Ya votaste":" · Elige una opción")+'</small></div>';
}

async function loadPostMeta(postIds){
  const out={};
  if(!postIds.length)return out;
  const placeholder=idsOrPlaceholder(postIds);
  const [likes,comments,reposts,reactions,saved,myReactions,polls]=await Promise.all([
    supabase.from("likes").select("post_id,user_id").in("post_id",placeholder),
    supabase.from("comments").select("post_id").in("post_id",placeholder),
    supabase.from("reposts").select("post_id,user_id").in("post_id",placeholder),
    supabase.from("post_reactions").select("post_id,user_id,type").in("post_id",placeholder),
    supabase.from("saved_posts").select("post_id").eq("user_id",session.user.id).in("post_id",placeholder),
    supabase.from("post_reactions").select("post_id,type").eq("user_id",session.user.id).in("post_id",placeholder),
    supabase.from("polls").select("*").in("post_id",placeholder)
  ]);
  for(const id of postIds)out[id]={likeCount:0,commentCount:0,repostCount:0,reactionCount:0,reactions:{},liked:false,saved:false,reposted:false,myReaction:null};
  for(const x of likes.data||[]){out[x.post_id].likeCount++;if(x.user_id===session.user.id)out[x.post_id].liked=true}
  for(const x of comments.data||[]){out[x.post_id].commentCount++}
  for(const x of reposts.data||[]){out[x.post_id].repostCount++;if(x.user_id===session.user.id)out[x.post_id].reposted=true}
  for(const x of reactions.data||[]){out[x.post_id].reactionCount++;out[x.post_id].reactions[x.type]=(out[x.post_id].reactions[x.type]||0)+1}
  for(const x of saved.data||[]){out[x.post_id].saved=true}
  for(const x of myReactions.data||[]){out[x.post_id].myReaction=x.type}
  const pollRows=polls.data||[];
  if(pollRows.length){
    const pollIds=pollRows.map(x=>x.id);
    const [opts,votes]=await Promise.all([supabase.from("poll_options").select("*").in("poll_id",pollIds),supabase.from("poll_votes").select("poll_id,option_id,user_id").in("poll_id",pollIds)]);
    const optionsByPoll={},votesByPoll={},ownVote={};
    for(const o of opts.data||[]){(optionsByPoll[o.poll_id]??=[]).push(o)}
    for(const v of votes.data||[]){votesByPoll[v.poll_id]??={};votesByPoll[v.poll_id][v.option_id]=(votesByPoll[v.poll_id][v.option_id]||0)+1;if(v.user_id===session.user.id)ownVote[v.poll_id]=v.option_id}
    for(const pl of pollRows){
      const id=pl.post_id,counts=votesByPoll[pl.id]||{};
      out[id].poll={id:pl.id,question:pl.question,options:optionsByPoll[pl.id]||[],votesByOption:counts,total:Object.values(counts).reduce((a,b)=>a+b,0),myVote:ownVote[pl.id]||null};
    }
  }
  return out;
}

function bindFeedControls(){
  $$("#addStoryBtn,#addStoryBtn2").forEach(b=>b.onclick=openStoryComposer);
  $$("[data-feedmode]").forEach(b=>b.onclick=()=>{feedMode=b.dataset.feedmode;renderFeed()});
  $$("[data-story-user]").forEach(b=>b.onclick=()=>openStoryViewer(b.dataset.storyUser));
  bindComposer();
}

function bindComposer(){
  $("#postBtn")?.addEventListener("click",createPost);
  $("#pollToggle")?.addEventListener("click",()=>{
    $("#pollComposer").classList.toggle("hidden");
    $("#pollToggle").classList.toggle("active-tool",!$("#pollComposer").classList.contains("hidden"));
  });
  $("#addPollOption")?.addEventListener("click",()=>{
    const wrap=$("#pollOptions"),n=wrap.querySelectorAll(".poll-option-input").length;
    if(n>=6)return toast("Una encuesta puede tener hasta 6 opciones.");
    const input=document.createElement("input");
    input.className="poll-option-input";input.maxLength=80;input.placeholder="Opción "+(n+1);wrap.appendChild(input);
  });
  $("#mediaInput")?.addEventListener("change",e=>{
    const file=e.target.files[0],prev=$("#mediaPreview");
    $("#fileName").textContent=file?file.name:"";
    if(!file){prev.classList.add("hidden");return}
    prev.innerHTML=file.type.startsWith("video/")?'<video controls src="'+URL.createObjectURL(file)+'"></video>':'<img src="'+URL.createObjectURL(file)+'" alt="Vista previa">';
    prev.classList.remove("hidden");
  });
}

async function createPost(){
  const btn=$("#postBtn"),text=($("#postText").value||"").trim(),file=$("#mediaInput").files[0];
  const pollOpen=!$("#pollComposer").classList.contains("hidden");
  let pollQuestion="",optionLabels=[];
  if(pollOpen){
    pollQuestion=($("#pollQuestion").value||"").trim();
    optionLabels=$$(".poll-option-input").map(x=>x.value.trim()).filter(Boolean);
    if(!pollQuestion)return toast("Escribe la pregunta de la encuesta.");
    if(optionLabels.length<2)return toast("Una encuesta necesita al menos 2 opciones.");
    if(new Set(optionLabels.map(x=>x.toLowerCase())).size!==optionLabels.length)return toast("No repitas opciones en la encuesta.");
  }
  if(!text&&!file&&!pollOpen)return toast("Escribe algo, elige multimedia o crea una encuesta.");
  btn.disabled=true;btn.textContent="Publicando…";
  let media=null;
  try{
    if(file)media=await uploadMedia(file,"posts",25);
    const postRes=await supabase.from("posts").insert({user_id:session.user.id,content:text||null,media_url:media?.url||null,media_type:media?.type||null,media_path:media?.path||null});
    if(postRes.error)throw postRes.error;
    const post=postRes.data?.[0]||postRes.data;
    if(pollOpen){
      const pRes=await supabase.from("polls").insert({post_id:post.id,question:pollQuestion});
      if(pRes.error)throw pRes.error;
      const poll=pRes.data?.[0]||pRes.data;
      const opts=await supabase.from("poll_options").insert(optionLabels.map((label,i)=>({poll_id:poll.id,label,position:i})));
      if(opts.error)throw opts.error;
    }
    $("#postText").value="";$("#mediaInput").value="";$("#fileName").textContent="";$("#mediaPreview").classList.add("hidden");$("#pollComposer").classList.add("hidden");$("#pollToggle").classList.remove("active-tool");$("#pollQuestion").value="";$("#pollOptions").innerHTML='<input class="poll-option-input" maxlength="80" placeholder="Opción 1"><input class="poll-option-input" maxlength="80" placeholder="Opción 2">';
    toast("¡Publicado! 🔥");await renderFeed();
  }catch(err){
    if(media?.path)await supabase.storage.from("media").remove([media.path]);
    toast("No se pudo publicar: "+(err.message||"error desconocido"));
  }finally{btn.disabled=false;btn.textContent="Publicar"}
}

function bindPostEvents(){
  $$("[data-profile]").forEach(b=>b.onclick=()=>renderProfile(b.dataset.profile));
  $$("[data-like]").forEach(b=>b.onclick=()=>toggleLike(b.dataset.like));
  $$("[data-save]").forEach(b=>b.onclick=()=>toggleSave(b.dataset.save));
  $("[data-repost]").forEach(b=>b.onclick=()=>toggleRepost(b.dataset.repost));
  $("[data-share]").forEach(b=>b.onclick=()=>sharePost(b.dataset.share));
  $$("[data-comments]").forEach(b=>b.onclick=()=>loadComments(b.dataset.comments));
  $$("[data-reaction-toggle]").forEach(b=>b.onclick=()=>$("#reaction-"+b.dataset.reactionToggle).classList.toggle("hidden"));
  $$("[data-reaction]").forEach(b=>b.onclick=()=>setReaction(b.dataset.post,b.dataset.reaction));
  $$("[data-menu]").forEach(b=>b.onclick=e=>{e.stopPropagation();$("#menu-"+b.dataset.menu).classList.toggle("hidden")});
  $$("[data-delete]").forEach(b=>b.onclick=()=>deletePost(b.dataset.delete));
  $$("[data-edit]").forEach(b=>b.onclick=()=>editPost(b.dataset.edit));
  $$("[data-report]").forEach(b=>b.onclick=()=>reportPost(b.dataset.report));
  $$("[data-block]").forEach(b=>b.onclick=()=>blockUser(b.dataset.block));
  $$("[data-vote]").forEach(b=>b.onclick=()=>votePoll(b.dataset.poll,b.dataset.vote));
  $$(".hashtag").forEach(b=>b.onclick=()=>searchEverything("#"+b.dataset.hashtag));
}

async function toggleLike(id){
  const q=await supabase.from("likes").select("post_id").eq("post_id",id).eq("user_id",session.user.id).maybeSingle();
  if(q.error)return toast(q.error.message);
  const r=q.data?await supabase.from("likes").delete().eq("post_id",id).eq("user_id",session.user.id):await supabase.from("likes").insert({post_id:id,user_id:session.user.id});
  if(r.error)return toast(r.error.message);
  await refreshNotifCount();
  await navigate(currentNav);
}

async function toggleSave(id){
  const q=await supabase.from("saved_posts").select("post_id").eq("post_id",id).eq("user_id",session.user.id).maybeSingle();
  if(q.error)return toast(q.error.message);
  const r=q.data?await supabase.from("saved_posts").delete().eq("post_id",id).eq("user_id",session.user.id):await supabase.from("saved_posts").insert({user_id:session.user.id,post_id:id});
  if(r.error)return toast(r.error.message);
  toast(q.data?"Quitado de guardados.":"Guardado 🔖");
  await navigate(currentNav);
}

async function toggleRepost(id){
  const q=await supabase.from("reposts").select("post_id").eq("post_id",id).eq("user_id",session.user.id).maybeSingle();
  if(q.error)return toast(q.error.message);
  const r=q.data?await supabase.from("reposts").delete().eq("post_id",id).eq("user_id",session.user.id):await supabase.from("reposts").insert({user_id:session.user.id,post_id:id});
  if(r.error)return toast(r.error.message);
  toast(q.data?"Repost eliminado.":"Repost publicado. 🔁");await navigate(currentNav);
}

async function sharePost(id){
  const url=new URL(window.location.href);
  url.hash="post-"+id;
  try{
    if(navigator.share){
      await navigator.share({title:"VibeNest",text:"Mira esta publicación en VibeNest",url:url.href});
      return;
    }
    await navigator.clipboard.writeText(url.href);
    toast("Enlace copiado. 🔗");
  }catch(err){
    if(err?.name!=="AbortError")toast("No se pudo compartir el enlace.");
  }
}

async function setReaction(postId,type){
  const q=await supabase.from("post_reactions").select("*").eq("post_id",postId).eq("user_id",session.user.id).maybeSingle();
  if(q.error)return toast(q.error.message);
  let r;
  if(q.data?.type===type)r=await supabase.from("post_reactions").delete().eq("post_id",postId).eq("user_id",session.user.id);
  else if(q.data)r=await supabase.from("post_reactions").update({type}).eq("post_id",postId).eq("user_id",session.user.id);
  else r=await supabase.from("post_reactions").insert({post_id:postId,user_id:session.user.id,type});
  if(r.error)return toast(r.error.message);
  await navigate(currentNav);
}

async function loadComments(id){
  const box=$("#comments-"+id);if(!box)return;
  const r=await supabase.from("comments").select("*").eq("post_id",id).order("created_at",{ascending:true});
  if(r.error)return toast(r.error.message);
  const users=await profilesByIds((r.data||[]).map(x=>x.user_id)),m=Object.fromEntries(users.map(p=>[p.id,p]));
  box.innerHTML=(r.data||[]).map(c=>{
    const own=c.user_id===session.user.id;
    return'<div class="comment"><button class="profile-link" data-profile="'+c.user_id+'">'+avatar(m[c.user_id],true)+'</button><div class="comment-body"><div><b>'+esc(m[c.user_id]?.display_name||"Usuario")+'</b><small>'+timeAgo(c.created_at)+'</small></div><p>'+esc(c.content)+'</p><div class="comment-tools">'+(own?'<button data-edit-comment="'+c.id+'">Editar</button><button data-delete-comment="'+c.id+'">Eliminar</button>':"")+'</div></div></div>';
  }).join("");
  box.innerHTML+=(r.data?.length?"":"<div class=\"comment-empty\">Sé el primero en comentar.</div>")+'<form class="comment-form" data-comment-form="'+id+'"><input maxlength="500" placeholder="Escribe un comentario…"><button>Enviar</button></form>';
  $("[data-comment-form='"+id+"']").onsubmit=async e=>{
    e.preventDefault();const input=e.target.querySelector("input"),value=input.value.trim();if(!value)return;
    const ins=await supabase.from("comments").insert({post_id:id,user_id:session.user.id,content:value});
    if(ins.error)toast(ins.error.message);else{input.value="";await loadComments(id);await refreshNotifCount()}
  };
  $$("[data-profile]",box).forEach(b=>b.onclick=()=>renderProfile(b.dataset.profile));
  $$("[data-edit-comment]",box).forEach(b=>b.onclick=()=>editComment(b.dataset.editComment,id));
  $$("[data-delete-comment]",box).forEach(b=>b.onclick=()=>deleteComment(b.dataset.deleteComment,id));
}

async function editComment(commentId,postId){
  const r=await supabase.from("comments").select("content").eq("id",commentId).eq("user_id",session.user.id).maybeSingle();
  if(r.error||!r.data)return toast("No se encontró el comentario.");
  openModal('<h2>Editar comentario</h2><form id="commentEditForm"><textarea id="commentEditText" maxlength="500">'+esc(r.data.content)+'</textarea><button class="primary wide">Guardar</button></form>');
  $("#commentEditForm").onsubmit=async e=>{
    e.preventDefault();const value=$("#commentEditText").value.trim();if(!value)return toast("El comentario no puede quedar vacío.");
    const u=await supabase.from("comments").update({content:value}).eq("id",commentId).eq("user_id",session.user.id);
    if(u.error)return toast(u.error.message);closeModal();loadComments(postId);
  };
}

async function deleteComment(commentId,postId){
  if(!confirm("¿Eliminar este comentario?"))return;
  const r=await supabase.from("comments").delete().eq("id",commentId).eq("user_id",session.user.id);
  if(r.error)toast(r.error.message);else loadComments(postId);
}

async function editPost(id){
  const p=await supabase.from("posts").select("*").eq("id",id).eq("user_id",session.user.id).maybeSingle();
  if(p.error||!p.data)return toast("No se encontró la publicación.");
  openModal('<h2>Editar publicación</h2><p class="muted">La multimedia se conserva; aquí puedes editar el texto.</p><form id="postEditForm"><textarea id="postEditText" maxlength="2200">'+esc(p.data.content||"")+'</textarea><button class="primary wide">Guardar cambios</button></form>');
  $("#postEditForm").onsubmit=async e=>{
    e.preventDefault();
    const u=await supabase.from("posts").update({content:$("#postEditText").value.trim(),edited_at:new Date().toISOString()}).eq("id",id).eq("user_id",session.user.id);
    if(u.error)return toast(u.error.message);
    closeModal();toast("Publicación actualizada.");await navigate(currentNav);
  };
}

async function deletePost(id){
  if(!confirm("¿Eliminar esta publicación? Esta acción no se puede deshacer."))return;
  const q=await supabase.from("posts").select("media_path").eq("id",id).eq("user_id",session.user.id).maybeSingle();
  const r=await supabase.from("posts").delete().eq("id",id).eq("user_id",session.user.id);
  if(r.error)return toast(r.error.message);
  if(q.data?.media_path)await supabase.storage.from("media").remove([q.data.media_path]);
  toast("Publicación eliminada.");await navigate(currentNav);
}

async function reportPost(id){
  const reason=await reasonModal("Reportar publicación","Elige el motivo",["spam","harassment","unsafe","impersonation","other"]);
  if(!reason)return;
  const details=prompt("Detalles adicionales (opcional):","")||"";
  const r=await supabase.from("reports").insert({reporter_id:session.user.id,target_post_id:id,reason,details});
  toast(r.error?r.error.message:"Reporte enviado. Gracias.");
}

async function reportUser(id){
  if(id===session.user.id)return;
  const reason=await reasonModal("Reportar usuario","Elige el motivo",["spam","harassment","unsafe","impersonation","other"]);
  if(!reason)return;
  const details=prompt("Detalles adicionales (opcional):","")||"";
  const r=await supabase.from("reports").insert({reporter_id:session.user.id,target_user_id:id,reason,details});
  toast(r.error?"No se pudo enviar el reporte.":"Reporte enviado. Gracias.");
}

function reasonModal(title,subtitle,options){
  return new Promise(resolve=>{
    openModal('<h2>'+esc(title)+'</h2><p class="muted">'+esc(subtitle)+'</p><div class="reason-grid">'+options.map(x=>'<button data-reason="'+x+'">'+({spam:"Spam",harassment:"Acoso",unsafe:"Contenido inseguro",impersonation:"Suplantación",other:"Otro"}[x]||x)+'</button>').join("")+'</div>');
    $$("[data-reason]").forEach(b=>b.onclick=()=>{closeModal();resolve(b.dataset.reason)});
  });
}

async function blockUser(id){
  if(id===session.user.id)return;
  if(!confirm("¿Bloquear a esta persona? Dejarás de ver su contenido y no podrá enviarte mensajes."))return;
  const r=await supabase.from("blocks").insert({blocker_id:session.user.id,blocked_id:id});
  if(r.error)return toast(r.error.message);
  toast("Usuario bloqueado.");await navigate(currentNav);
}

async function unblockUser(id){
  const r=await supabase.from("blocks").delete().eq("blocker_id",session.user.id).eq("blocked_id",id);
  toast(r.error?r.error.message:"Usuario desbloqueado.");
  if(!r.error)renderSettings();
}

async function votePoll(pollId,optionId){
  const q=await supabase.from("poll_votes").select("*").eq("poll_id",pollId).eq("user_id",session.user.id).maybeSingle();
  if(q.error)return toast(q.error.message);
  let r;
  if(q.data){
    if(q.data.option_id===optionId)return;
    r=await supabase.from("poll_votes").update({option_id:optionId}).eq("poll_id",pollId).eq("user_id",session.user.id);
  }else r=await supabase.from("poll_votes").insert({poll_id:pollId,option_id:optionId,user_id:session.user.id});
  if(r.error)return toast(r.error.message);
  toast("Voto registrado.");await navigate(currentNav);
}

async function renderExplore(){
  const r=await supabase.from("posts").select("*").order("created_at",{ascending:false}).limit(100);
  if(r.error)return toast(r.error.message);
  const blocked=await currentBlockIds();
  const rawPosts=(r.data||[]).filter(p=>!blocked.has(p.user_id));
  const profilesForVisibility=await profilesByIds(rawPosts.map(p=>p.user_id));
  const visibilityMap=Object.fromEntries(profilesForVisibility.map(p=>[p.id,p]));
  const followingRes=await supabase.from("follows").select("following_id").eq("follower_id",session.user.id);
  const followingSet=new Set((followingRes.data||[]).map(x=>x.following_id));
  const posts=rawPosts.filter(p=>{
    const author=visibilityMap[p.user_id];
    return author?.profile_visibility!=="private" || p.user_id===session.user.id || followingSet.has(p.user_id);
  });
  const meta=await loadPostMeta(posts.map(p=>p.id)),now=Date.now();
  posts.sort((a,b)=>{
    const score=p=>((meta[p.id]?.likeCount||0)*3+(meta[p.id]?.commentCount||0)*2+(meta[p.id]?.repostCount||0)*4+(meta[p.id]?.reactionCount||0)*2)+Math.max(0,72-(now-new Date(p.created_at))/3600000)*0.1;
    return score(b)-score(a);
  });
  const profiles=await profilesByIds(posts.map(p=>p.user_id));
  $("#content").innerHTML=pageHeader("Explorar","Descubre posts, hashtags y gente nueva.")+'<div class="pulse card"><div><span class="pulse-kicker">VIBENEST PULSE</span><h2>Lo que está vibrando ahora</h2><p>Popularidad combinada con actividad reciente.</p></div><div class="pulse-stat">🔥 '+formatCount(posts.length)+' posts</div></div><div class="search-tools"><input id="exploreSearch" placeholder="Buscar personas, posts o #hashtags"><button class="primary" id="exploreSearchBtn">Buscar</button></div><div id="exploreList">'+(posts.map(p=>postHtml(p,profiles.find(x=>x.id===p.user_id),meta[p.id])).join("")||'<div class="card empty">Todavía no hay contenido para explorar.</div>')+'</div>';
  $("#exploreSearchBtn").onclick=()=>searchEverything($("#exploreSearch").value);
  $("#exploreSearch").onkeydown=e=>{if(e.key==="Enter")searchEverything(e.target.value)};
  bindPostEvents();
}

async function searchEverything(query){
  const q=query.trim().replace(/^#/,"");if(!q)return;
  const pattern="%"+q.replace(/[\\%_]/g,m=>"\\"+m)+"%";
  const [userByName,displayByName,posts]=await Promise.all([
    supabase.from("profiles").select("*").ilike("username",pattern).limit(20),
    supabase.from("profiles").select("*").ilike("display_name",pattern).limit(20),
    supabase.from("posts").select("*").ilike("content",pattern).order("created_at",{ascending:false}).limit(40)
  ]);
  if(userByName.error||displayByName.error||posts.error)return toast((userByName.error||displayByName.error||posts.error).message);
  const userMap=new Map([...(userByName.data||[]),...(displayByName.data||[])].map(p=>[p.id,p]));
  const users=[...userMap.values()].filter(p=>p.id===session.user.id||p.profile_visibility!=="private");
  const meta=await loadPostMeta((posts.data||[]).map(p=>p.id)),postProfiles=await profilesByIds((posts.data||[]).map(p=>p.user_id));
  const userHtml=users.map(p=>'<div class="result-row">'+avatar(p,true)+'<div><button class="plain-link" data-profile="'+p.id+'">'+esc(p.display_name)+'</button><small>@'+esc(p.username)+'</small></div><span class="spacer"></span><button class="secondary-btn" data-profile="'+p.id+'">Ver</button></div>').join("")||'<div class="empty compact">No se encontraron personas.</div>';
  const postHtmlList=(posts.data||[]).map(p=>postHtml(p,postProfiles.find(x=>x.id===p.user_id),meta[p.id])).join("")||'<div class="card empty">No se encontraron publicaciones.</div>';
  $("#content").innerHTML=pageHeader("Resultados","Búsqueda para “"+q+"”.")+'<section class="card results-block"><h3>Personas</h3>'+userHtml+'</section><section class="results-posts"><h3>Publicaciones</h3>'+postHtmlList+'</section>';
  $$("[data-profile]").forEach(b=>b.onclick=()=>renderProfile(b.dataset.profile));bindPostEvents();
}

async function renderSaved(){
  const s=await supabase.from("saved_posts").select("post_id,created_at").eq("user_id",session.user.id).order("created_at",{ascending:false}).limit(100);
  if(s.error)return toast(s.error.message);
  const ids=(s.data||[]).map(x=>x.post_id);
  if(!ids.length){$("#content").innerHTML=pageHeader("Guardados","Tu colección privada.")+'<div class="card empty">No tienes publicaciones guardadas todavía. 🔖</div>';return}
  const p=await supabase.from("posts").select("*").in("id",ids).order("created_at",{ascending:false});
  const meta=await loadPostMeta(ids),users=await profilesByIds((p.data||[]).map(x=>x.user_id)),map=Object.fromEntries(users.map(x=>[x.id,x]));
  $("#content").innerHTML=pageHeader("Guardados","Las publicaciones que quieres volver a ver.")+(p.data||[]).map(x=>postHtml(x,map[x.user_id],meta[x.id])).join("");
  bindPostEvents();
}

async function renderProfile(id){
  const p=await profileById(id);if(!p)return;
  const own=id===session.user.id;
  const [posts,followers,following,follow,blockedByMe,reposts]=await Promise.all([
    supabase.from("posts").select("*").eq("user_id",id).order("created_at",{ascending:false}).limit(80),
    supabase.from("follows").select("follower_id",{count:"exact",head:true}).eq("following_id",id),
    supabase.from("follows").select("following_id",{count:"exact",head:true}).eq("follower_id",id),
    own?{data:null}:supabase.from("follows").select("*").eq("follower_id",session.user.id).eq("following_id",id).maybeSingle(),
    own?{data:null}:supabase.from("blocks").select("*").eq("blocker_id",session.user.id).eq("blocked_id",id).maybeSingle(),
    supabase.from("reposts").select("post_id,created_at").eq("user_id",id).order("created_at",{ascending:false}).limit(60)
  ]);
  const blocked=!!blockedByMe?.data;
  const repIds=(reposts.data||[]).map(x=>x.post_id);
  let repPosts=[];
  if(repIds.length){const rr=await supabase.from("posts").select("*").in("id",repIds);repPosts=rr.data||[]}
  const accessAllowed=own||!blocked&&(p.profile_visibility!=="private"||!!follow?.data);
  const visiblePosts=accessAllowed?(profileTab==="posts"?(posts.data||[]):repPosts):[];
  const visibleMeta=await loadPostMeta(visiblePosts.map(x=>x.id));
  const ownPostIds=(posts.data||[]).map(x=>x.id);
  const likeRows=ownPostIds.length?await supabase.from("likes").select("post_id").in("post_id",ownPostIds):{data:[]};
  const interests=(p.interests||[]).map(i=>'<span class="chip">#'+esc(i)+'</span>').join("");
  let actions="";
  if(own)actions='<button class="primary" id="editProfileBtn">Editar perfil</button><button class="secondary-btn" id="achievementsBtn">🏆 Logros</button>';
  else if(blocked)actions='<button class="secondary-btn" id="unblockProfileBtn">Desbloquear</button>';
  else actions='<button class="primary" id="followProfileBtn">'+(follow.data?"Dejar de seguir":"Seguir")+'</button><button class="secondary-btn" id="messageProfileBtn">💬 Mensaje</button><button class="icon-btn large" id="profileMenuBtn">•••</button>';
  $("#content").innerHTML='<section class="card profile-card"><div class="cover" '+(p.cover_url?'style="background-image:url('+esc(p.cover_url)+')"':"")+'></div><div class="profile-body"><div class="profile-main"><div class="profile-avatar-wrap">'+avatar(p)+'</div><div class="profile-actions">'+actions+'</div></div><div class="profile-copy"><h1>'+esc(p.display_name)+'</h1><div class="profile-username">@'+esc(p.username)+'</div><p>'+renderRichText(p.bio||"Sin biografía todavía.")+'</p>'+(p.website?'<a class="website" href="'+esc(/^https?:\/\//i.test(p.website)?p.website:"https://"+p.website)+'" target="_blank" rel="noopener noreferrer">🔗 '+esc(p.website)+'</a>':"")+'<div class="chips">'+interests+'</div></div><div class="stats"><span><b>'+formatCount(posts.data?.length||0)+'</b><small>posts</small></span><span><b>'+formatCount(followers.count||0)+'</b><small>seguidores</small></span><span><b>'+formatCount(following.count||0)+'</b><small>siguiendo</small></span><span><b>'+formatCount(likeRows.data?.length||0)+'</b><small>likes</small></span></div></div></section><div class="profile-tabs card"><button class="'+(profileTab==="posts"?"active":"")+'" data-profiletab="posts">Publicaciones</button><button class="'+(profileTab==="reposts"?"active":"")+'" data-profiletab="reposts">Reposts</button></div><div id="profilePosts">'+(visiblePosts.map(x=>postHtml(x,p,visibleMeta[x.id]||{})).join("")||'<div class="card empty">No hay publicaciones aquí.</div>')+'</div>';
  $$("[data-profiletab]").forEach(b=>b.onclick=()=>{profileTab=b.dataset.profiletab;renderProfile(id)});
  bindPostEvents();
  if(own){
    $("#editProfileBtn").onclick=editProfileModal;
    $("#achievementsBtn").onclick=showAchievements;
  }else if(blocked){
    $("#unblockProfileBtn").onclick=()=>unblockUser(id);
  }else{
    $("#followProfileBtn").onclick=()=>toggleFollow(id,!!follow.data);
    $("#messageProfileBtn").onclick=async()=>{currentChatUser=p;await navigate("messages");await openChat(p)};
    $("#profileMenuBtn").onclick=()=>reasonOrBlockProfile(id);
  }
}

async function toggleFollow(id,isFollowing){
  const r=isFollowing?await supabase.from("follows").delete().eq("follower_id",session.user.id).eq("following_id",id):await supabase.from("follows").insert({follower_id:session.user.id,following_id:id});
  if(r.error)return toast(r.error.message);
  toast(isFollowing?"Dejaste de seguir.":"Ahora sigues a esta persona. 👋");await refreshNotifCount();await renderProfile(id);
}

function reasonOrBlockProfile(id){
  openModal('<h2>Opciones</h2><div class="option-list"><button id="reportProfileModal">🚩 Reportar usuario</button><button id="blockProfileModal">⛔ Bloquear usuario</button></div>');
  $("#reportProfileModal").onclick=()=>{closeModal();reportUser(id)};
  $("#blockProfileModal").onclick=()=>{closeModal();blockUser(id)};
}

async function editProfileModal(){
  const p=currentProfile;
  openModal('<h2>Editar perfil</h2><form id="editProfileForm" class="settings-form"><div class="edit-image-grid"><label class="upload-card">Avatar<input id="avatarFile" type="file" accept="image/*"><span>Subir nueva foto</span></label><label class="upload-card">Portada<input id="coverFile" type="file" accept="image/*"><span>Subir portada</span></label></div><label>Nombre visible<input id="editName" maxlength="40" value="'+esc(p.display_name)+'"></label><label>Usuario<input id="editUser" maxlength="24" value="'+esc(p.username)+'"></label><label>Bio<textarea id="editBio" maxlength="160">'+esc(p.bio||"")+'</textarea></label><label>Web<input id="editWebsite" maxlength="180" value="'+esc(p.website||"")+'"></label><label>Intereses <small class="muted">separados por comas</small><input id="editInterests" maxlength="160" value="'+esc((p.interests||[]).join(", "))+'"></label><button class="primary wide">Guardar cambios</button></form>');
  $("#editProfileForm").onsubmit=async e=>{
    e.preventDefault();
    const username=$("#editUser").value.trim().toLowerCase();
    if(!/^[a-z0-9_]{3,24}$/.test(username))return toast("Usuario: 3-24 caracteres, letras, números o _.");
    const data={display_name:$("#editName").value.trim(),username,bio:$("#editBio").value.trim(),website:$("#editWebsite").value.trim(),interests:$("#editInterests").value.split(",").map(x=>x.trim().toLowerCase().replace(/[^a-z0-9áéíóúñü_-]/gi,"")).filter(Boolean).slice(0,8)};
    try{
      const avatarFile=$("#avatarFile").files[0],coverFile=$("#coverFile").files[0];
      if(avatarFile)data.avatar_url=(await uploadMedia(avatarFile,"avatars",8)).url;
      if(coverFile)data.cover_url=(await uploadMedia(coverFile,"covers",12)).url;
    }catch(err){return toast(err.message)}
    const u=await supabase.from("profiles").update(data).eq("id",session.user.id);
    if(u.error)return toast(u.error.message);
    currentProfile=await profileById(session.user.id);renderMini();closeModal();toast("Perfil actualizado.");await renderProfile(session.user.id);
  };
}

async function showAchievements(){
  const [posts,followers,following]=await Promise.all([
    supabase.from("posts").select("id",{count:"exact",head:true}).eq("user_id",session.user.id),
    supabase.from("follows").select("follower_id",{count:"exact",head:true}).eq("following_id",session.user.id),
    supabase.from("follows").select("following_id",{count:"exact",head:true}).eq("follower_id",session.user.id)
  ]);
  const ownPosts=await supabase.from("posts").select("id").eq("user_id",session.user.id).limit(1000);
  const likes=ownPosts.data?.length?await supabase.from("likes").select("post_id").in("post_id",ownPosts.data.map(x=>x.id)):{data:[]};
  const likeCount=(likes.data||[]).length;
  const checks=[["🌱","Primer post",(posts.count||0)>=1],["✍️","Creador activo",(posts.count||0)>=5],["❤️","Tu primera ola de likes",likeCount>=10],["👥","10 seguidores",(followers.count||0)>=10],["🤝","Sigues a 10 personas",(following.count||0)>=10],["🔥","Creador destacado",likeCount>=50]];
  openModal('<h2>🏆 Logros</h2><p class="muted">Pequeños hitos para darle personalidad a VibeNest.</p><div class="achievement-grid">'+checks.map(x=>'<div class="achievement '+(x[2]?"unlocked":"")+'"><span>'+x[0]+'</span><div><b>'+x[1]+'</b><small>'+ (x[2]?"Desbloqueado":"Todavía bloqueado")+'</small></div></div>').join("")+'</div>');
}

async function renderNotifications(){
  const r=await supabase.from("notifications").select("*").eq("recipient_id",session.user.id).order("created_at",{ascending:false}).limit(80);
  if(r.error)return toast(r.error.message);
  const users=await profilesByIds((r.data||[]).map(x=>x.actor_id)),m=Object.fromEntries(users.map(p=>[p.id,p]));
  $("#content").innerHTML=pageHeader("Notificaciones","Lo que ha pasado mientras estabas fuera.")+'<div class="card notifications-card">'+((r.data||[]).map(n=>'<div class="notification '+(!n.read?"unread":"")+'">'+avatar(m[n.actor_id],true)+'<div><b>'+esc(m[n.actor_id]?.display_name||"VibeNest")+'</b><p>'+esc(n.message||"Hay una actualización.")+'</p><small>'+timeAgo(n.created_at)+'</small></div></div>').join("")||'<div class="empty">No tienes notificaciones nuevas.</div>')+'</div>';
  await supabase.from("notifications").update({read:true}).eq("recipient_id",session.user.id).eq("read",false);
  await refreshNotifCount();
}

async function renderMessages(openDefault){
  currentGroup=null;
  const sent=await supabase.from("messages").select("*").eq("sender_id",session.user.id).order("created_at",{ascending:false}).limit(150);
  const received=await supabase.from("messages").select("*").eq("recipient_id",session.user.id).order("created_at",{ascending:false}).limit(150);
  if(sent.error||received.error)return toast((sent.error||received.error).message);
  const all=[...(sent.data||[]),...(received.data||[])],byOther=new Map();
  for(const msg of all){
    const other=msg.sender_id===session.user.id?msg.recipient_id:msg.sender_id,old=byOther.get(other);
    if(!old||new Date(msg.created_at)>new Date(old.created_at))byOther.set(other,msg);
  }
  const contacts=await profilesByIds([...byOther.keys()]);
  const unread=new Set((received.data||[]).filter(x=>!x.read_at).map(x=>x.sender_id));
  $("#content").innerHTML='<div class="messages-shell card"><aside class="chat-list"><div class="chat-list-head"><div><h2>Mensajes</h2><small>Conversaciones privadas</small></div><button class="icon-btn" id="newChatBtn">＋</button></div><input id="chatSearch" class="chat-search" placeholder="Buscar personas…"><div id="chatContacts">'+(contacts.sort((a,b)=>new Date(byOther.get(b.id)?.created_at||0)-new Date(byOther.get(a.id)?.created_at||0)).map(p=>'<button class="chat-contact '+(currentChatUser?.id===p.id?"active":"")+'" data-chat="'+p.id+'">'+avatar(p,true)+'<span><b>'+esc(p.display_name)+'</b><small>'+(unread.has(p.id)?"Nuevo mensaje":"@"+esc(p.username))+'</small></span><em>'+timeAgo(byOther.get(p.id)?.created_at||new Date())+'</em></button>').join("")||'<div class="empty compact">Todavía no tienes chats.</div>')+'</div></aside><section id="chatPanel" class="chat-panel"></section></div>';
  $$("[data-chat]").forEach(b=>b.onclick=async()=>{const p=contacts.find(x=>x.id===b.dataset.chat);currentChatUser=p;await openChat(p)});
  $("#newChatBtn").onclick=openNewChat;
  if(openDefault&&currentChatUser)await openChat(currentChatUser);
  else if(!currentChatUser&&contacts[0]){currentChatUser=contacts[0];await openChat(contacts[0])}
  else $("#chatPanel").innerHTML='<div class="chat-empty"><span>💬</span><h3>Elige una conversación</h3><p>Busca una persona para empezar a hablar.</p><button class="primary" id="startChatBtn">Nuevo chat</button></div>';
  $("#startChatBtn")?.addEventListener("click",openNewChat);
  $("#chatSearch")?.addEventListener("input",e=>{
    const q=e.target.value.toLowerCase().trim();
    $$(".chat-contact").forEach(b=>b.style.display=b.innerText.toLowerCase().includes(q)?"flex":"none");
  });
}

async function openNewChat(){
  openModal('<h2>Nuevo chat</h2><input id="newChatSearch" placeholder="Buscar por usuario o nombre"><div id="newChatResults" class="modal-results"></div>');
  const search=async()=>{
    const q=$("#newChatSearch").value.trim();if(!q)return $("#newChatResults").innerHTML="";
    const pattern="%"+q.replace(/[\\%_]/g,m=>"\\"+m)+"%";
    const [u,d]=await Promise.all([supabase.from("profiles").select("*").ilike("username",pattern).limit(12),supabase.from("profiles").select("*").ilike("display_name",pattern).limit(12)]);
    const map=new Map([...(u.data||[]),...(d.data||[])].map(p=>[p.id,p]));
    $("#newChatResults").innerHTML=[...map.values()].filter(p=>p.id!==session.user.id).map(p=>'<button class="modal-result" data-startchat="'+p.id+'">'+avatar(p,true)+'<span><b>'+esc(p.display_name)+'</b><small>@'+esc(p.username)+'</small></span></button>').join("")||'<div class="empty compact">No hay resultados.</div>';
    $$("[data-startchat]").forEach(b=>b.onclick=async()=>{const p=await profileById(b.dataset.startchat);closeModal();currentChatUser=p;await renderMessages(false);await openChat(p)});
  };
  $("#newChatSearch").oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(search,250)};
}

async function openChat(user){
  currentChatUser=user;
  const panel=$("#chatPanel");if(!panel)return;
  panel.innerHTML='<div class="chat-header">'+avatar(user,true)+'<div><b>'+esc(user.display_name)+'</b><small>@'+esc(user.username)+(user.allow_messages===false?" · mensajes limitados":"")+'</small></div><button class="icon-btn" id="chatUserOptions">•••</button></div><div id="chatMessages" class="chat-messages"><div class="loading">Cargando…</div></div><form id="chatForm" class="chat-compose"><input id="chatInput" maxlength="2000" placeholder="Escribe un mensaje…"><button class="primary">Enviar</button></form>';
  $("#chatForm").onsubmit=async e=>{
    e.preventDefault();
    const input=$("#chatInput"),body=input.value.trim();if(!body)return;
    const r=await supabase.from("messages").insert({sender_id:session.user.id,recipient_id:user.id,body});
    if(r.error)return toast(r.error.message);
    input.value="";await refreshConversation(false);refreshNotifCount();
  };
  $("#chatUserOptions").onclick=()=>{openModal('<h2>Opciones de conversación</h2><div class="option-list"><button id="chatReportBtn">🚩 Reportar usuario</button><button id="chatBlockBtn">⛔ Bloquear usuario</button></div>');$("#chatReportBtn").onclick=()=>{closeModal();reportUser(user.id)};$("#chatBlockBtn").onclick=()=>{closeModal();blockUser(user.id)}};
  await refreshConversation(true);
}

async function refreshConversation(scrollBottom){
  if(!currentChatUser||currentNav!=="messages")return;
  const r1=await supabase.from("messages").select("*").eq("sender_id",session.user.id).eq("recipient_id",currentChatUser.id).order("created_at",{ascending:true}).limit(250);
  const r2=await supabase.from("messages").select("*").eq("sender_id",currentChatUser.id).eq("recipient_id",session.user.id).order("created_at",{ascending:true}).limit(250);
  if(r1.error||r2.error)return;
  const msgs=[...(r1.data||[]),...(r2.data||[])].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)),box=$("#chatMessages");
  if(!box)return;
  box.innerHTML=msgs.map(m=>'<div class="chat-msg '+(m.sender_id===session.user.id?"mine":"")+'"><div class="bubble">'+esc(m.body)+'</div><small>'+timeAgo(m.created_at)+(m.sender_id===session.user.id?(m.read_at?" · leído":""):"")+'</small></div>').join("")||'<div class="chat-empty compact"><span>👋</span><p>Empieza la conversación.</p></div>';
  const unread=msgs.filter(m=>m.sender_id===currentChatUser.id&&!m.read_at).map(m=>m.id);
  if(unread.length){await supabase.from("messages").update({read_at:new Date().toISOString()}).in("id",unread).eq("recipient_id",session.user.id);refreshNotifCount()}
  if(scrollBottom)box.scrollTop=box.scrollHeight;
}

async function renderGroups(){
  const g=await supabase.from("groups").select("*").order("created_at",{ascending:false}).limit(80);
  if(g.error)return toast(g.error.message);
  const member=await supabase.from("group_members").select("group_id").eq("user_id",session.user.id).limit(100);
  const mine=new Set((member.data||[]).map(x=>x.group_id)),users=await profilesByIds((g.data||[]).map(x=>x.owner_id)),m=Object.fromEntries(users.map(x=>[x.id,x]));
  $("#content").innerHTML=pageHeader("Grupos","Comunidades para hablar de tus vibes.",'<button class="primary" id="createGroupBtn">＋ Crear grupo</button>')+'<div class="group-grid">'+((g.data||[]).map(group=>{
    const joined=mine.has(group.id);
    return'<article class="card group-card"><div class="group-icon">👥</div><h3>'+esc(group.name)+'</h3><p>'+esc(group.description||"Sin descripción.")+'</p><small>Creado por '+esc(m[group.owner_id]?.display_name||"Usuario")+'</small><div class="group-actions">'+(joined?'<button class="primary" data-open-group="'+group.id+'">Abrir</button><button class="secondary-btn" data-leave-group="'+group.id+'">Salir</button>':'<button class="secondary-btn" data-join-group="'+group.id+'">Unirme</button>')+'</div></article>';
  }).join("")||'<div class="card empty">Aún no hay grupos.</div>')+'</div>';
  $("#createGroupBtn").onclick=createGroup;
  $$("[data-open-group]").forEach(b=>b.onclick=()=>openGroup(b.dataset.openGroup));
  $$("[data-join-group]").forEach(b=>b.onclick=()=>joinGroup(b.dataset.joinGroup));
  $$("[data-leave-group]").forEach(b=>b.onclick=()=>leaveGroup(b.dataset.leaveGroup));
}

async function createGroup(){
  openModal('<h2>Crear grupo</h2><form id="groupForm"><label>Nombre<input id="groupName" maxlength="60" required></label><label>Descripción<textarea id="groupDescription" maxlength="240"></textarea></label><button class="primary wide">Crear</button></form>');
  $("#groupForm").onsubmit=async e=>{
    e.preventDefault();
    const ins=await supabase.from("groups").insert({owner_id:session.user.id,name:$("#groupName").value.trim(),description:$("#groupDescription").value.trim()});
    if(ins.error)return toast(ins.error.message);
    const group=ins.data?.[0]||ins.data,mem=await supabase.from("group_members").insert({group_id:group.id,user_id:session.user.id});
    if(mem.error)return toast(mem.error.message);
    closeModal();toast("Grupo creado. 👥");renderGroups();
  };
}

async function joinGroup(id){
  const r=await supabase.from("group_members").insert({group_id:id,user_id:session.user.id});
  toast(r.error?r.error.message:"Te uniste al grupo.");if(!r.error)renderGroups();
}

async function leaveGroup(id){
  if(!confirm("¿Salir de este grupo?"))return;
  const r=await supabase.from("group_members").delete().eq("group_id",id).eq("user_id",session.user.id);
  if(r.error)return toast(r.error.message);
  if(currentGroup?.id===id){currentGroup=null;await renderGroups()}else renderGroups();
}

async function openGroup(id){
  const g=await supabase.from("groups").select("*").eq("id",id).maybeSingle();
  if(g.error||!g.data)return toast("No se encontró el grupo.");
  currentGroup=g.data;
  $("#content").innerHTML='<div class="group-chat card"><div class="group-chat-head"><button class="icon-btn" id="backGroups">←</button><div class="group-icon small">👥</div><div><h2>'+esc(g.data.name)+'</h2><small>'+esc(g.data.description||"")+'</small></div></div><div id="groupMessages" class="chat-messages"></div><form id="groupFormMsg" class="chat-compose"><input id="groupMsgInput" maxlength="2000" placeholder="Escribe al grupo…"><button class="primary">Enviar</button></form></div>';
  $("#backGroups").onclick=()=>{currentGroup=null;navigate("groups")};
  $("#groupFormMsg").onsubmit=async e=>{
    e.preventDefault();const body=$("#groupMsgInput").value.trim();if(!body)return;
    const r=await supabase.from("group_messages").insert({group_id:id,user_id:session.user.id,body});
    if(r.error)return toast(r.error.message);
    $("#groupMsgInput").value="";refreshGroupChat(true);
  };
  await refreshGroupChat(true);startLiveRefresh();
}

async function refreshGroupChat(scroll){
  if(!currentGroup||currentNav!=="groups")return;
  const r=await supabase.from("group_messages").select("*").eq("group_id",currentGroup.id).order("created_at",{ascending:true}).limit(250);
  if(r.error)return;
  const users=await profilesByIds((r.data||[]).map(x=>x.user_id)),map=Object.fromEntries(users.map(x=>[x.id,x])),box=$("#groupMessages");
  if(!box)return;
  box.innerHTML=(r.data||[]).map(m=>'<div class="chat-msg '+(m.user_id===session.user.id?"mine":"")+'"><small class="group-sender">'+esc(map[m.user_id]?.display_name||"Usuario")+'</small><div class="bubble">'+esc(m.body)+'</div><small>'+timeAgo(m.created_at)+'</small></div>').join("")||'<div class="chat-empty compact"><span>👥</span><p>Escribe el primer mensaje.</p></div>';
  if(scroll)box.scrollTop=box.scrollHeight;
}

function openStoryComposer(){
  openModal('<h2>Crear story</h2><p class="muted">Tu story estará visible durante 24 horas.</p><form id="storyForm"><label>Foto o video<input id="storyFile" type="file" accept="image/*,video/*" required></label><label>Texto opcional<textarea id="storyCaption" maxlength="220"></textarea></label><button class="primary wide">Publicar story</button></form>');
  $("#storyForm").onsubmit=async e=>{
    e.preventDefault();
    try{
      const media=await uploadMedia($("#storyFile").files[0],"stories",15);
      const r=await supabase.from("stories").insert({user_id:session.user.id,media_url:media.url,media_type:media.type,media_path:media.path,caption:$("#storyCaption").value.trim()});
      if(r.error)throw r.error;
      closeModal();toast("Story publicada. ✨");await renderFeed();
    }catch(err){toast("No se pudo publicar: "+err.message)}
  };
}

async function openStoryViewer(userId){
  const r=await supabase.from("stories").select("*").eq("user_id",userId).order("created_at",{ascending:true}).limit(20);
  if(r.error)return toast(r.error.message);
  const active=(r.data||[]).filter(x=>new Date(x.expires_at)>new Date());
  if(!active.length)return toast("Esta story ya expiró.");
  const p=await profileById(userId);let index=0;
  const render=()=>{
    const s=active[index],media=s.media_type==="video"?'<video class="story-view-media" controls autoplay src="'+esc(s.media_url)+'"></video>':'<img class="story-view-media" src="'+esc(s.media_url)+'" alt="Story">';
    $("#storyViewer").innerHTML='<div class="story-stage"><div class="story-stage-head">'+avatar(p,true)+'<b>'+esc(p.display_name)+'</b><small>'+timeAgo(s.created_at)+'</small><button class="modal-close story-close">×</button></div>'+media+(s.caption?'<div class="story-caption">'+esc(s.caption)+'</div>':"")+'<div class="story-nav"><button id="storyPrev">‹</button><span>'+((index+1)+" / "+active.length)+'</span><button id="storyNext">›</button></div>'+(userId===session.user.id?'<button class="danger-btn" id="deleteStoryBtn">Eliminar story</button>':"")+'</div>';
    $("#storyPrev").onclick=()=>{if(index>0){index--;render()}};
    $("#storyNext").onclick=()=>{if(index<active.length-1){index++;render()}};
    $(".story-close").onclick=closeModal;
    $("#deleteStoryBtn")?.addEventListener("click",()=>deleteStory(s));
  };
  openModal('<div id="storyViewer"></div>');render();
}

async function deleteStory(s){
  if(!confirm("¿Eliminar esta story?"))return;
  const r=await supabase.from("stories").delete().eq("id",s.id).eq("user_id",session.user.id);
  if(r.error)return toast(r.error.message);
  if(s.media_path)await supabase.storage.from("media").remove([s.media_path]);
  closeModal();toast("Story eliminada.");renderFeed();
}

async function renderSettings(){
  const p=currentProfile,blocks=await supabase.from("blocks").select("blocked_id,created_at").eq("blocker_id",session.user.id),blockedProfiles=await profilesByIds((blocks.data||[]).map(x=>x.blocked_id));
  $("#content").innerHTML=pageHeader("Configuración","Personaliza cómo funciona VibeNest para ti.")+'<div class="settings-grid"><section class="card settings-card"><h3>Cuenta y perfil</h3><p class="muted">Gestiona la información que ven las demás personas.</p><button class="settings-row" id="settingsEditProfile"><span>👤 Editar perfil</span><b>›</b></button><button class="settings-row" id="settingsProfilePage"><span>👀 Ver mi perfil</span><b>›</b></button></section><section class="card settings-card"><h3>Apariencia</h3><label>Tema<select id="themeSelect"><option value="system">Sistema</option><option value="light">Claro</option><option value="dark">Oscuro</option></select></label></section><section class="card settings-card"><h3>Privacidad</h3><label class="switch-row"><span><b>Permitir mensajes</b><small>Las personas podrán iniciar chats contigo.</small></span><input id="allowMessages" type="checkbox" '+(p.allow_messages!==false?"checked":"")+'></label><label class="switch-row"><span><b>Perfil público</b><small>Tu perfil aparece en búsquedas y exploración.</small></span><input id="profilePublic" type="checkbox" '+(p.profile_visibility!=="private"?"checked":"")+'></label></section><section class="card settings-card"><h3>Usuarios bloqueados</h3>'+(blockedProfiles.map(x=>'<div class="blocked-row">'+avatar(x,true)+'<span><b>'+esc(x.display_name)+'</b><small>@'+esc(x.username)+'</small></span><button class="secondary-btn" data-unblock="'+x.id+'">Desbloquear</button></div>').join("")||'<div class="empty compact">No has bloqueado a nadie.</div>')+'</section><section class="card settings-card"><h3>Comunidad</h3><button class="settings-row" id="settingsRules"><span>📜 Reglas de VibeNest</span><b>›</b></button><button class="settings-row" id="settingsAchievements"><span>🏆 Mis logros</span><b>›</b></button></section><section class="card settings-card danger-card"><h3>Sesión</h3><p class="muted">Cierra sesión en este dispositivo.</p><button class="danger-btn" id="settingsLogout">Cerrar sesión</button></section></div>';
  $("#themeSelect").value=localStorage.vibeTheme||"system";
  $("#themeSelect").onchange=e=>setTheme(e.target.value);
  $("#settingsEditProfile").onclick=editProfileModal;$("#settingsProfilePage").onclick=()=>renderProfile(session.user.id);$("#settingsRules").onclick=rules;$("#settingsAchievements").onclick=showAchievements;$("#settingsLogout").onclick=()=>supabase.auth.signOut();
  $("#allowMessages").onchange=async e=>{const r=await supabase.from("profiles").update({allow_messages:e.target.checked}).eq("id",session.user.id);if(r.error){e.target.checked=!e.target.checked;toast(r.error.message)}else currentProfile=await profileById(session.user.id)};
  $("#profilePublic").onchange=async e=>{const value=e.target.checked?"public":"private",r=await supabase.from("profiles").update({profile_visibility:value}).eq("id",session.user.id);if(r.error){e.target.checked=!e.target.checked;toast(r.error.message)}else currentProfile=await profileById(session.user.id)};
  $$("[data-unblock]").forEach(b=>b.onclick=()=>unblockUser(b.dataset.unblock));
}

function rules(){
  openModal('<h2>📜 Reglas de VibeNest</h2><div class="rules"><p><b>1. Respeto.</b> Trata a las demás personas con consideración.</p><p><b>2. Privacidad.</b> No publiques datos personales de otras personas sin permiso.</p><p><b>3. Seguridad.</b> No publiques contenido que ponga a alguien en peligro.</p><p><b>4. Reportes.</b> Usa los reportes cuando algo incumpla las reglas.</p><p><b>5. Credenciales.</b> Mantén tu contraseña privada y usa contraseñas únicas.</p><p><b>6. Comunidad.</b> VibeNest funciona mejor cuando cada persona ayuda a mantener un ambiente sano.</p></div>');
}

function openModal(html){
  $("#modalContent").innerHTML=html;$("#modal").classList.remove("hidden");
}

function closeModal(){
  $("#modal").classList.add("hidden");$("#modalContent").innerHTML="";
}

document.addEventListener("click",e=>{
  const nav=e.target.closest("[data-nav]");if(nav){e.preventDefault();navigate(nav.dataset.nav)}
  const prof=e.target.closest(".mini-profile");if(prof)navigate("profile");
  if(e.target.id==="rulesBtn"||e.target.id==="rulesBtn2")rules();
});

$$("[data-auth]").forEach(b=>b.onclick=()=>{
  authMode=b.dataset.auth;$$("[data-auth]").forEach(x=>x.classList.toggle("active",x===b));
  $("#displayWrap").classList.toggle("hidden",authMode==="login");$("#usernameWrap").classList.toggle("hidden",authMode==="login");$("#authSubmit").textContent=authMode==="login"?"Entrar":"Crear cuenta";
});

$("#authForm").onsubmit=async e=>{
  e.preventDefault();
  const email=$("#email").value.trim(),password=$("#password").value,username=$("#username").value.trim().toLowerCase(),displayName=$("#displayName").value.trim(),btn=$("#authSubmit");
  btn.disabled=true;btn.textContent=authMode==="login"?"Entrando…":"Creando…";
  try{
    if(authMode==="login"){
      const r=await supabase.auth.signInWithPassword({email,password});
      if(r.error)return showAuthError(r.error);
      if(r.data?.session)await handleSession(r.data.session);
    }else{
      if(!/^[a-z0-9_]{3,24}$/.test(username))return toast("Usuario: 3-24 caracteres, letras, números o _.");
      const r=await supabase.auth.signUp({email,password,options:{data:{username,display_name:displayName||username},emailRedirectTo:window.location.origin}});
      if(r.error)return showAuthError(r.error);
      if(r.data?.session){await handleSession(r.data.session);toast("¡Cuenta creada! 🎉")}
      else if(r.data?.user){localStorage.setItem("vibenest_pending_profile",JSON.stringify({email,username,displayName:displayName||username}));toast("Cuenta creada. Revisa tu correo para confirmarla.")}
    }
  }catch(err){showAuthError(err)}
  finally{btn.disabled=false;btn.textContent=authMode==="login"?"Entrar":"Crear cuenta"}
};

$("#logoutBtn").onclick=()=>supabase.auth.signOut();
$("#themeBtn").onclick=()=>{const current=localStorage.vibeTheme||"system";setTheme(current==="dark"?"light":"dark")};
$("#searchInput").oninput=e=>{clearTimeout(searchTimer);const q=e.target.value.trim();if(!q)return;searchTimer=setTimeout(()=>searchEverything(q),500)};
$("#searchInput").onkeydown=e=>{if(e.key==="Enter")searchEverything(e.target.value)};
$("#modal").onclick=e=>{if(e.target.id==="modal")closeModal()};
$(".modal-close").onclick=closeModal;

window.VIBENEST_APP_READY=true;
boot();