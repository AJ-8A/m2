const API_BASE = "https://ajchat-api.study4u-aj.workers.dev";
const TOKEN_KEY = "m2_token";
const WS_BASE = API_BASE.replace(/^http/,"ws");

const state = {
  mode: "login",
  token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem("ajchat_token") || "",
  me: null,
  friends: [],
  groups: [],
  activeFriend: null,
  activeGroup: null,
  currentFilter: "all",
  socket: null,
  callSocket: null,
  callSocketRetry: 0,
  pollTimer: null,
  groupPollTimer: null,
  messages: [],
  historyMessages: [],
  incomingRequests: [],
  outgoingRequests: [],
  presenceTimer: null,
  friendRefreshTimer: null,
  friendRequestTimer: null,
  typingTimer: null,
  replyTo: null,
  notifications: (typeof Notification !== "undefined" && Notification.permission === "granted") || localStorage.getItem("ajchat_notifications") === "on",
  rtc: null,
  localStream: null,
  callMode: null,
  callPeer: null,
  callTimer: null,
  callStartedAt: 0,
  incomingCall: null,
  pendingIceCandidates: [],
  callPeerId: null,
  notificationRegistration: null,
  socialTab: "home",
  socialRefreshTimer: null,
  globalSocket: null,
  globalMessages: [],
  globalPollTimer: null,
  chatLoadSeq: 0
};

const el = id => document.getElementById(id);
const toast = el("toast");
const sidebar = el("sidebar");
const chatList = el("chatList");
const messagesBox = el("messages");
const input = el("messageInput");
const CHAT_CACHE_PREFIX="ajchat_history_v2:";
const CHAT_CACHE_LIMIT=120;
function chatCacheKey(kind,id){return CHAT_CACHE_PREFIX+kind+":"+String(id||"").toLowerCase()}
function readChatCache(kind,id){try{const raw=localStorage.getItem(chatCacheKey(kind,id));const data=raw?JSON.parse(raw):[];return Array.isArray(data)?data:[]}catch{return []}}
function writeChatCache(kind,id,messages){if(!id)return;try{localStorage.setItem(chatCacheKey(kind,id),JSON.stringify((messages||[]).slice(-CHAT_CACHE_LIMIT)))}catch{}}
function mergeMessages(base,incoming){const map=new Map();[...(base||[]),...(incoming||[])].forEach(m=>{if(m&&m.id!=null)map.set(String(m.id),m)});return [...map.values()].sort((x,y)=>Number(x.id)-Number(y.id)).slice(-CHAT_CACHE_LIMIT)}
function ensureScrollControl(){
  if(el("chatScrollButton"))return el("chatScrollButton");
  const button=document.createElement("button");
  button.id="chatScrollButton";button.className="chat-scroll-button hidden";button.type="button";button.setAttribute("aria-label","Scroll to latest messages");button.title="Jump to latest";button.textContent="↓";
  button.addEventListener("click",()=>{messagesBox.scrollTo({top:messagesBox.scrollHeight,behavior:"smooth"});button.classList.add("hidden")});
  el("chatPanel")?.appendChild(button);return button;
}
function updateScrollControl(){
  const button=ensureScrollControl();if(!button)return;
  const distance=messagesBox.scrollHeight-messagesBox.scrollTop-messagesBox.clientHeight;
  const depth=Math.min(1,Math.max(0,messagesBox.scrollTop/900));
  messagesBox.closest(".chat-scene")?.style.setProperty("--scroll-depth",depth.toFixed(3));
  button.classList.toggle("hidden",distance<180);
  messagesBox.classList.toggle("chat-scrolling",distance>12);
}

function escapeHTML(value){
  return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

function showToast(text){
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.t);
  showToast.t=setTimeout(()=>toast.classList.remove("show"),2200);
}

function authHeaders(json=false){
  const h={};
  if(state.token) h.Authorization="Bearer "+state.token;
  if(json) h["Content-Type"]="application/json";
  return h;
}

async function api(path,options={}){
  const response=await fetch(API_BASE+path,{
    ...options,
    headers:{...authHeaders(Boolean(options.body)),...(options.headers||{})},
    cache:"no-store"
  });
  let data={};
  try{data=await response.json()}catch{}
  if(!response.ok){
    if(response.status===401 && !path.startsWith("/api/auth/")){
      handleSessionExpired();
    }
    throw new Error(data.error||"Request failed");
  }
  return data;
}

function handleSessionExpired(){
  if(!state.token)return;
  state.token=""; state.me=null;
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem("ajchat_token");
  clearInterval(state.presenceTimer); state.presenceTimer=null;
  clearInterval(state.friendRefreshTimer); state.friendRefreshTimer=null;
  clearInterval(state.friendRequestTimer); state.friendRequestTimer=null;
  clearInterval(state.pollTimer); state.pollTimer=null;
  clearInterval(state.groupPollTimer); state.groupPollTimer=null;
  try{state.socket?.close()}catch{} state.socket=null;
  try{state.globalSocket?.close()}catch{} state.globalSocket=null;
  showAuth(true);
  setAuthMessage("Your session expired. Please sign in again.",true);
}

function setAuthMessage(text,error=false){
  const node=el("authMessage");
  node.textContent=text||"";
  node.className="auth-message"+(error?" error":"");
}

function showAuth(show){
  el("authScreen").classList.toggle("hidden",!show);
}

function renderAuthMode(){
  const create=state.mode==="register";
  el("authSubmit").textContent=create?"Create account":"Sign in";
  el("authSwitch").textContent=create?"Already have an account? Sign in":"New here? Create an account";
  el("authPassword").autocomplete=create?"new-password":"current-password";
}

async function submitAuth(event){
  event.preventDefault();
  const username=el("authUsername").value.trim();
  const password=el("authPassword").value;
  setAuthMessage("Connecting…");

  try{
    const data=await api("/api/auth/"+state.mode,{
      method:"POST",
      body:JSON.stringify({username,password})
    });

    state.token=data.token;
    state.me=data.user;
    localStorage.setItem(TOKEN_KEY,state.token);
    localStorage.removeItem("ajchat_token");

    showAuth(false);
    setAuthMessage("");
    showToast(state.mode==="register"?"Account created. You're in.":"You're in.");

    await registerNotifications();
    refreshNotificationPrompt();
    if(typeof Notification !== "undefined" && Notification.permission==="granted"){
      state.notifications=true;
      localStorage.setItem("ajchat_notifications","on");
      syncPushSubscription().catch(()=>{});
    }
    startPresence();
    startFriendRefresh();
    startFriendRequestRefresh();

    Promise.all([
      loadFriends(false),
      loadFriendRequests()
    ]).then(async()=>{
      renderFriendList();
      if(state.friends.length){
        enterFirstChatMode();
        if(isMobileLayout())showMobileFriendList();
      }else{
        renderEmptyFriends();
      }
    }).catch(error=>{
      renderFriendList();
      if(!state.friends.length && !state.activeFriend) renderEmptyFriends();
      showToast(error?.message||"Could not load your friends.");
    });
  }catch(error){
    setAuthMessage(error.message,true);
  }
}

registerNotifications();

function socialDate(value){
  if(!value)return "";
  const d=new Date(Number(value)*1000),now=Date.now(),diff=now-d.getTime();
  if(diff<60000)return "just now";
  if(diff<3600000)return Math.floor(diff/60000)+"m";
  if(diff<86400000)return Math.floor(diff/3600000)+"h";
  return d.toLocaleDateString([], {day:"numeric",month:"short"});
}
function socialAvatar(item){
  return escapeHTML(item?.avatar||item?.initials||item?.username?.slice(0,2).toUpperCase()||"AJ");
}
function postCard(post){
  const liked=Boolean(post.liked),saved=Boolean(post.saved);
  const media=post.media_url?("<a class='social-media-link' href='"+escapeHTML(post.media_url)+"' target='_blank' rel='noopener noreferrer'>View shared media ↗</a>"):"";
  return "<article class='post-card' data-post-id='"+Number(post.id)+"'>"+
    "<header class='post-head'><button class='social-user' data-social-user='"+escapeHTML(post.username)+"' type='button'><span class='social-avatar'>"+socialAvatar(post)+"</span><span><strong>@"+escapeHTML(post.username)+"</strong><small>"+socialDate(post.created_at)+"</small></span></button>"+
    (post.author_id===state.me?.id||post.username===state.me?.username?"<button class='post-more' data-post-action='delete' type='button'>•••</button>":"")+"</header>"+
    (post.body?"<div class='post-body'>"+escapeHTML(post.body).replace(/\\n/g,"<br>")+"</div>":"")+media+
    "<footer class='post-actions'>"+
      "<button type='button' data-post-action='like' class='"+(liked?"active":"")+"'>♡ <span>"+(Number(post.like_count||0))+"</span></button>"+
      "<button type='button' data-post-action='comment'>◌ <span>"+(Number(post.comment_count||0))+"</span></button>"+
      "<button type='button' data-post-action='save' class='"+(saved?"active":"")+"'>🔖</button>"+
      "<button type='button' data-post-action='share'>↗</button>"+
    "</footer></article>";
}
function socialComposer(){
  return "<article class='create-post-card'><div class='create-post-top'><div class='social-avatar'>"+socialAvatar(state.me)+"</div><div><strong>Share something</strong><small>Post to your AJChat community</small></div></div>"+
    "<textarea id='socialPostText' maxlength='1000' placeholder=\"What's on your mind?\"></textarea>"+
    "<input id='socialPostMedia' type='url' maxlength='500' placeholder='Optional image/link URL'>"+
    "<div class='create-post-actions'><span>✨ Text-first social</span><button class='primary-social' id='createPostButton' type='button'>Post</button></div></article>";
}
async function createSocialPost(){
  const body=el("socialPostText")?.value.trim()||"",media=el("socialPostMedia")?.value.trim()||"";
  if(!body&&!media){showToast("Write something first.");return}
  try{await api("/api/social/posts",{method:"POST",body:JSON.stringify({body,media_url:media})});showToast("Posted.");await loadSocial("home")}catch(error){showToast(error.message)}
}
async function togglePostAction(postId,action){
  if(action==="share"){
    const url=location.href.split("#")[0]+"#post-"+postId;
    try{if(navigator.share)await navigator.share({title:"AJChat post",url});else await navigator.clipboard.writeText(url);showToast("Post link copied.");}catch{}
    return;
  }
  if(action==="comment"){
    const body=prompt("Write a comment:");
    if(!body?.trim())return;
    try{await api("/api/social/posts/"+postId+"/comment",{method:"POST",body:JSON.stringify({body:body.trim()})});showToast("Comment added.");await loadSocial(state.socialTab)}catch(error){showToast(error.message)}
    return;
  }
  if(action==="delete"&&confirm("Delete this post?")){
    try{await api("/api/social/posts/"+postId+"/delete",{method:"POST",body:"{}"});showToast("Post deleted.");await loadSocial(state.socialTab)}catch(error){showToast(error.message)}
    return;
  }
  if(action==="like"||action==="save"){
    try{await api("/api/social/posts/"+postId+"/"+action,{method:"POST",body:"{}"});await loadSocial(state.socialTab)}catch(error){showToast(error.message)}
  }
}
function closeGlobalSocket(){
  if(state.globalPollTimer){clearInterval(state.globalPollTimer);state.globalPollTimer=null}
  if(state.globalSocket){try{state.globalSocket.close()}catch{} state.globalSocket=null}
}
async function loadGlobalHistory(){
  const data=await api("/api/social/global/messages");
  state.globalMessages=data.messages||[];
}
function renderGlobalMessages(){
  const box=el("globalMessages");if(!box)return;
  if(!state.globalMessages.length){box.innerHTML="<div class='global-empty-chat'>No messages yet. Say hello to everyone 👋</div>";return}
  box.innerHTML=state.globalMessages.map(m=>{
    const mine=m.username===state.me?.username;
    return "<article class='global-message "+(mine?"mine":"")+"'><div class='global-message-avatar'>"+socialAvatar(m)+"</div><div class='global-message-body'><div class='global-message-meta'><button class='global-user-name' data-social-user='"+escapeHTML(m.username)+"' type='button'>@"+escapeHTML(m.username)+"</button>"+(mine?"":"<button class='global-follow-mini' data-follow-user='"+escapeHTML(m.username)+"' type='button'>Follow</button>")+"</div><p>"+escapeHTML(m.body).replace(/\\n/g,"<br>")+"</p><time>"+socialDate(m.created_at)+"</time></div></article>";
  }).join("");
  box.scrollTop=box.scrollHeight;
}
function connectGlobalSocket(){
  closeGlobalSocket();
  if(!state.token)return;
  const socket=new WebSocket(WS_BASE+"/ws?room=global&token="+encodeURIComponent(state.token));
  state.globalSocket=socket;
  socket.onopen=()=>{if(state.globalSocket===socket)setStatusGlobal("Connected to Global Chat");};
  socket.onmessage=event=>{
    if(state.globalSocket!==socket)return;
    try{
      const data=JSON.parse(event.data);
      if(data.type==="history"&&Array.isArray(data.messages)){
        const merged=new Map();
        for(const message of state.globalMessages||[]) merged.set(Number(message.id),message);
        for(const message of data.messages) merged.set(Number(message.id),message);
        state.globalMessages=[...merged.values()].sort((a,b)=>Number(a.id)-Number(b.id)).slice(-100);
        renderGlobalMessages();
      }
      if(data.type==="message"&&data.message){
        state.globalMessages.push(data.message);
        state.globalMessages=state.globalMessages.slice(-100);
        renderGlobalMessages();
        if(data.message.username!==state.me?.username)notifyIncoming({id:"global-"+data.message.id,sender:data.message.username,body:data.message.body});
      }
      if(data.type==="rate_limited")setStatusGlobal(data.message||"Slow down a little.");
      if(data.type==="ready")setStatusGlobal(data.online?"Connected • people are here":"Connected • be the first to chat");
      if(data.type==="presence")setStatusGlobal(data.online?"Someone joined Global Chat":"A user left Global Chat");
    }catch{}
  };
  socket.onclose=()=>{
    if(state.globalSocket!==socket)return;
    state.globalSocket=null;
    setStatusGlobal("Reconnecting…");
    state.globalPollTimer=setInterval(async()=>{
      try{await loadGlobalHistory();renderGlobalMessages()}catch{}
    },3000);
    setTimeout(()=>{if(state.socialTab==="global"&&state.token)connectGlobalSocket()},1500);
  };
  socket.onerror=()=>setStatusGlobal("Connection unstable — retrying");
}
function setStatusGlobal(text){const n=el("globalChatStatus");if(n)n.textContent=text}
async function sendGlobalMessage(){
  const field=el("globalMessageInput");const text=field?.value.trim()||"";
  if(!text)return;
  if(!state.globalSocket||state.globalSocket.readyState!==WebSocket.OPEN){showToast("Global Chat is reconnecting…");connectGlobalSocket();return}
  try{state.globalSocket.send(JSON.stringify({type:"message",text}));field.value="";field.focus()}catch{showToast("Could not send global message.")}
}
async function renderGlobalSocial(){
  await loadGlobalHistory();
  el("socialContent").innerHTML="<section class='global-chat-shell'><header class='global-chat-head'><div><span class='eyebrow'>PUBLIC AJCHAT</span><h3>Global Chat</h3><p id='globalChatStatus'>Connecting…</p></div><span class='global-live-pill'><i></i>Live</span></header><div class='global-messages' id='globalMessages'></div><form class='global-composer' id='globalComposer'><input id='globalMessageInput' maxlength='500' placeholder='Message everyone…' autocomplete='off'><button type='submit'>Send</button></form><div class='global-chat-note'>Be respectful. Everyone on AJChat can read this room.</div></section>";
  renderGlobalMessages();
  el("globalComposer")?.addEventListener("submit",event=>{event.preventDefault();sendGlobalMessage()});
  connectGlobalSocket();
}
async function renderHomeSocial(){
  const data=await api("/api/social/feed");
  const stories=await api("/api/social/stories");
  const storyCards=(stories.stories||[]).slice(0,12).map(story=>"<button class='story-card "+(story.viewed?"viewed":"")+" ' data-story-id='"+story.id+"' type='button'><span class='story-ring'><span class='social-avatar'>"+socialAvatar(story)+"</span></span><strong>@"+escapeHTML(story.username)+"</strong><small>"+socialDate(story.created_at)+"</small></button>").join("");
  el("socialContent").innerHTML=socialComposer()+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>STORIES</span><h3>Quick updates</h3></div><button class='mini-social-btn' data-social-tab='stories'>See all</button></div>"+
    "<div class='stories-row'>"+(storyCards||"<div class='social-empty'>No active stories yet. Be the first.</div>")+"</div></section>"+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>YOUR FEED</span><h3>For you</h3></div><button class='mini-social-btn' id='refreshSocialButton'>Refresh</button></div><div class='post-feed'>"+
    ((data.posts||[]).map(postCard).join("")||"<div class='social-empty'>Follow people or add friends to grow your feed.</div>")+"</div></section>";
}
async function renderExploreSocial(){
  const q=el("socialExploreInput")?.value.trim()||"";
  const data=await api("/api/social/explore?q="+encodeURIComponent(q));
  const people=(data.people||[]).map(person=>"<article class='explore-person'><button class='social-user' data-social-user='"+escapeHTML(person.username)+"' type='button'><span class='social-avatar'>"+socialAvatar(person)+"</span><span><strong>@"+escapeHTML(person.username)+"</strong><small>"+escapeHTML(person.bio||"AJChat member")+"</small></span></button><div class='person-actions'><button class='follow-btn "+(person.following?"following":"")+"' data-follow-user='"+escapeHTML(person.username)+"' type='button'>"+(person.following?"Following":"+ Follow")+"</button>"+friendButtonMarkup(person.username,person.friend_status)+"</div></article>").join("");
  const posts=(data.posts||[]).map(postCard).join("");
  el("socialContent").innerHTML="<section class='follow-by-username'><div class='follow-by-username-copy'><span class='eyebrow'>DIRECT FOLLOW</span><strong>Follow anyone by username</strong><small>Use their exact AJChat username. You can unfollow from the same box.</small></div><div class='follow-by-username-form'><span>@</span><input id='followUsernameInput' maxlength='24' autocomplete='off' autocapitalize='none' spellcheck='false' placeholder='username'><button id='followUsernameButton' type='button'>Follow</button></div><div class='follow-username-note' id='followUsernameNote'></div></section>"+
    "<section class='explore-search'><span>⌕</span><input id='socialExploreInput' value='"+escapeHTML(q)+"' placeholder='Search people or posts'><button id='socialExploreSearch' type='button'>Search</button></section>"+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>DISCOVER</span><h3>People to follow</h3></div></div><div class='people-grid'>"+(people||"<div class='social-empty'>No people found.</div>")+"</div></section>"+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>EXPLORE</span><h3>Public posts</h3></div></div><div class='post-feed'>"+(posts||"<div class='social-empty'>No public posts match that search.</div>")+"</div></section>";
  const followInput=el("followUsernameInput"), followButton=el("followUsernameButton"), followNote=el("followUsernameNote");
  const submitUsernameFollow=async()=>{
    const username=(followInput?.value||"").trim().replace(/^@+/,"");
    if(!username){if(followNote)followNote.textContent="Enter a username first.";return}
    if(username.toLowerCase()===(state.me?.username||"").toLowerCase()){if(followNote)followNote.textContent="You cannot follow yourself.";return}
    if(followButton){followButton.disabled=true;followButton.textContent="Working…"}
    if(followNote)followNote.textContent="";
    try{
      const result=await api("/api/social/follow/"+encodeURIComponent(username),{method:"POST",body:"{}"});
      const action=result.following?"Following":"Unfollowed";
      if(followInput)followInput.value="";
      if(followNote)followNote.textContent=(action==="Following"?"Now following @":"Unfollowed @")+result.username+".";
      showToast(action+" @"+result.username+".");
      await renderExploreSocial();
    }catch(error){
      if(followNote)followNote.textContent=error.message;
      showToast(error.message);
    }finally{
      if(followButton){followButton.disabled=false;followButton.textContent="Follow"}
    }
  };
  followButton?.addEventListener("click",submitUsernameFollow);
  followInput?.addEventListener("keydown",e=>{if(e.key==="Enter")submitUsernameFollow()});
  el("socialExploreSearch")?.addEventListener("click",()=>renderExploreSocial());
  el("socialExploreInput")?.addEventListener("keydown",e=>{if(e.key==="Enter")renderExploreSocial()});
}
async function renderStoriesSocial(){
  const data=await api("/api/social/stories");
  el("socialContent").innerHTML="<article class='create-post-card story-composer'><div class='create-post-top'><div class='social-avatar'>"+socialAvatar(state.me)+"</div><div><strong>Share a story</strong><small>Stories disappear after 24 hours.</small></div></div><textarea id='storyText' maxlength='240' placeholder='What is happening?'></textarea><div class='create-post-actions'><span>24h • text story</span><button class='primary-social' id='createStoryButton' type='button'>Share story</button></div></article>"+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>ACTIVE NOW</span><h3>Stories</h3></div></div><div class='story-grid'>"+((data.stories||[]).map(story=>"<article class='story-full "+(story.viewed?"viewed":"")+"'><div class='story-top'><span class='social-avatar'>"+socialAvatar(story)+"</span><div><strong>@"+escapeHTML(story.username)+"</strong><small>"+socialDate(story.created_at)+"</small></div></div><p>"+escapeHTML(story.body).replace(/\\n/g,"<br>")+"</p><button type='button' class='mini-social-btn' data-story-view='"+story.id+"'>"+(story.viewed?"Viewed":"Mark viewed")+"</button></article>").join("")||"<div class='social-empty'>No stories yet.</div>")+"</div></section>";
  el("createStoryButton")?.addEventListener("click",async()=>{const body=el("storyText").value.trim();if(!body)return;try{await api("/api/social/stories",{method:"POST",body:JSON.stringify({body})});await loadSocial("stories");showToast("Story shared for 24 hours.");}catch(error){showToast(error.message)}});
}
async function renderSavedSocial(){
  const data=await api("/api/social/saved");
  el("socialContent").innerHTML="<section class='social-section'><div class='section-head'><div><span class='eyebrow'>BOOKMARKS</span><h3>Saved posts</h3></div></div><div class='post-feed'>"+((data.posts||[]).map(postCard).join("")||"<div class='social-empty'>Nothing saved yet.</div>")+"</div></section>";
}
async function renderNotificationsSocial(){
  const data=await api("/api/social/notifications");
  el("socialContent").innerHTML="<section class='social-section'><div class='section-head'><div><span class='eyebrow'>ACTIVITY</span><h3>Notifications</h3></div><button class='mini-social-btn' id='markSocialRead' type='button'>Mark all read</button></div><div class='notification-list'>"+((data.notifications||[]).map(item=>"<article class='social-notification "+(item.read_at?"":"unread")+"'><span class='social-avatar'>"+socialAvatar(item)+"</span><div><strong>"+escapeHTML(item.body)+"</strong><small>"+socialDate(item.created_at)+"</small></div></article>").join("")||"<div class='social-empty'>You're all caught up.</div>")+"</div></section>";
  el("markSocialRead")?.addEventListener("click",async()=>{await api("/api/social/notifications/read",{method:"POST",body:"{}"});await renderNotificationsSocial()});
}
async function renderProfileSocial(username=state.me?.username){
  const data=await api("/api/social/profile/"+encodeURIComponent(username));
  el("socialContent").innerHTML="<section class='profile-social-head'><div class='profile-social-avatar'>"+socialAvatar(data.profile)+"</div><div class='profile-social-copy'><div><span class='eyebrow'>PROFILE</span><h3>@"+escapeHTML(data.username)+"</h3></div><p>"+escapeHTML(data.profile.bio||"No bio yet.")+"</p><span class='profile-status-pill'>"+escapeHTML(data.profile.status||"Available to chat")+"</span></div><div class='profile-social-actions'>"+(data.self?"<button class='primary-social' id='editSocialProfile'>Edit profile</button>":"<div class='profile-social-buttons'><button class='follow-btn "+(data.following?"following":"")+"' data-follow-user='"+escapeHTML(data.username)+"'>"+(data.following?"Following":"Follow")+"</button>"+friendButtonMarkup(data.username,data.friend_status)+"</div>")+"</div></section>"+
    "<div class='profile-stats'><span><strong>"+data.stats.posts+"</strong>Posts</span><span><strong>"+data.stats.followers+"</strong>Followers</span><span><strong>"+data.stats.following+"</strong>Following</span></div>"+
    "<section class='social-section'><div class='section-head'><div><span class='eyebrow'>POSTS</span><h3>"+(data.self?"Your posts":"@"+escapeHTML(data.username)+"'s posts")+"</h3></div></div><div class='post-feed'>"+((data.posts||[]).map(postCard).join("")||"<div class='social-empty'>No posts yet.</div>")+"</div></section>";
  el("editSocialProfile")?.addEventListener("click",()=>openProfile(state.me.username,true));
}
async function loadSocial(tab=state.socialTab){
  if(!state.token||!state.me){
    closeGlobalSocket();
    el("socialPanel").classList.add("hidden");
    el("chatPanel").classList.remove("hidden");
    showAuth(true);
    setAuthMessage("Please sign in to continue.",true);
    return;
  }
  if(state.socialTab==="global"&&tab!=="global")closeGlobalSocket();
  state.socialTab=tab;
  el("chatPanel").classList.add("hidden");el("socialPanel").classList.remove("hidden");
  document.querySelectorAll(".social-tab").forEach(b=>b.classList.toggle("active",b.dataset.socialTab===tab));
  const title={home:"Home feed",global:"Global Chat",explore:"Explore",stories:"Stories",saved:"Saved",profile:"Your profile",notifications:"Notifications"}[tab]||"AJChat Social";
  el("socialTitle").textContent=title;el("socialSubtitle").textContent=tab==="home"?"See what your people are sharing.":tab==="global"?"One public room for the whole AJChat community.":"Discover the AJChat community.";
  el("socialContent").innerHTML="<div class='social-loading'>Loading…</div>";
  try{
    if(tab==="home")await renderHomeSocial();
    else if(tab==="global")await renderGlobalSocial();
    else if(tab==="explore")await renderExploreSocial();
    else if(tab==="stories")await renderStoriesSocial();
    else if(tab==="saved")await renderSavedSocial();
    else if(tab==="profile")await renderProfileSocial();
    else if(tab==="notifications"){await renderNotificationsSocial();await api("/api/social/notifications/read",{method:"POST",body:"{}"}).catch(()=>{})}
    sidebar.classList.add("closed");
  }catch(error){el("socialContent").innerHTML="<div class='social-empty'>"+escapeHTML(error.message)+"</div>"}
}
function closeSocial(){el("socialPanel").classList.add("hidden");el("chatPanel").classList.remove("hidden")}
function friendButtonMarkup(username,status){
  const safe=escapeHTML(username);
  if(status==="friends")return "<button class='follow-btn friend-btn friends' data-friend-user='"+safe+"' type='button'>✓ Friends</button>";
  if(status==="pending")return "<button class='follow-btn friend-btn pending' data-friend-user='"+safe+"' type='button' disabled>Requested</button>";
  if(status==="incoming")return "<button class='follow-btn friend-btn pending' data-friend-user='"+safe+"' type='button' disabled>Request waiting</button>";
  return "<button class='follow-btn friend-btn' data-friend-user='"+safe+"' type='button'>＋ Add Friend</button>";
}
async function followUser(username){try{await api("/api/social/follow/"+encodeURIComponent(username),{method:"POST",body:"{}"});showToast("Follow status updated.");await loadSocial(state.socialTab)}catch(error){showToast(error.message)}}
async function addFriendUser(username){
  try{
    const result=await api("/api/friends",{method:"POST",body:JSON.stringify({username})});
    if(result.status==="friends")showToast("@"+username+" is already your friend.");
    else if(result.status==="incoming")showToast("You already have a request from @"+username+".");
    else showToast("Friend request sent to @"+username+".");
    await loadSocial(state.socialTab);
    await loadFriendRequests().catch(()=>{});
  }catch(error){showToast(error.message)}
}
async function boot(){
  renderAuthMode();
  el("authForm").addEventListener("submit",submitAuth);
  el("authSwitch").addEventListener("click",()=>{
    state.mode=state.mode==="login"?"register":"login";
    setAuthMessage("");
    renderAuthMode();
    el("authUsername").focus();
  });
  if(!state.token){showAuth(true);return;}
  try{
    state.me=await api("/api/me");
    showAuth(false);
    refreshNotificationPrompt();
    syncPushSubscription().catch(()=>{});
    startPresence();
    startFriendRefresh();
    startFriendRequestRefresh();

    Promise.all([
      loadFriends(false),
      loadFriendRequests()
    ]).then(async()=>{
      renderFriendList();
      if(!state.activeFriend){
        enterFirstChatMode();
      }
    }).catch(error=>{
      renderFriendList();
      if(!state.friends.length) renderEmptyFriends();
      showToast(error?.message||"Could not load your friends.");
    });
  }catch{
    localStorage.removeItem("ajchat_token");
    state.token="";
    showAuth(true);
  }
}

async function sendPresence(){
  if(!state.token)return;
  try{
    await api("/api/presence",{method:"POST",body:"{}"});
    const dot=el("selfStatusDot"), label=el("selfStatusText");
    if(dot){dot.classList.remove("offline");dot.classList.add("online")}
    if(label)label.textContent="Online";
  }catch{
    const dot=el("selfStatusDot"), label=el("selfStatusText");
    if(dot){dot.classList.remove("online");dot.classList.add("offline")}
    if(label)label.textContent="Offline";
  }
}

function startPresence(){
  if(state.presenceTimer || !state.token)return;
  sendPresence();
  state.presenceTimer=setInterval(sendPresence,15000);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")sendPresence()},{passive:true});
}

async function refreshFriendStates(){
  if(!state.token)return;
  try{
    const [friendData, groupData] = await Promise.all([api("/api/friends"), api("/api/groups")]);
    state.friends=friendData.friends||[];
    state.groups=groupData.groups||[];
    renderOnlineFriends();
    renderFriendList();
    if(state.activeFriend){
      const active=state.friends.find(f=>f.username===state.activeFriend);
      if(active)el("chatStatus").textContent=active.online?"Online now":"Offline — messages will be saved";
    }else if(state.activeGroup){
      const active=state.groups.find(g=>Number(g.id)===Number(state.activeGroup));
      if(active)el("chatStatus").textContent=active.member_count+" members • group chat";
    }
  }catch{}
}

function startFriendRefresh(){
  if(state.friendRefreshTimer || !state.token)return;
  refreshFriendStates();
  state.friendRefreshTimer=setInterval(refreshFriendStates,10000);
}
async function loadFriends(shouldRender=true){
  const data=await api("/api/friends");
  state.friends=data.friends||[];
  renderOnlineFriends();
  if(shouldRender)renderFriendList();
  if(state.activeFriend && !state.friends.some(f=>f.username===state.activeFriend)){
    state.activeFriend=null;
  }
  renderOnlineFriends();
  if(!state.friends.length) renderEmptyFriends();
}

async function loadGroups(shouldRender=true){
  try{
    const data=await api("/api/groups");
    state.groups=data.groups||[];
  }catch{
    state.groups=[];
  }
  if(shouldRender)renderFriendList();
  if(state.activeGroup && !state.groups.some(g=>Number(g.id)===Number(state.activeGroup))){
    state.activeGroup=null;
  }
}

function renderOnlineFriends(){
  const strip=el("onlineStrip");
  const count=el("onlineCount");
  const avatars=el("onlineAvatars");
  if(!strip||!count||!avatars)return;

  const online=state.friends.filter(friend=>friend.online);
  count.textContent=String(online.length);
  strip.hidden=online.length===0;
  avatars.innerHTML="";

  online.slice(0,8).forEach(friend=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="online-avatar";
    button.title=friend.username+" is online";
    button.setAttribute("aria-label","Open chat with "+friend.username);
    button.innerHTML="<span class=\"online-avatar-face\">"+escapeHTML(friend.initials||friend.username.slice(0,2).toUpperCase())+"</span><i></i>";
    button.addEventListener("click",()=>selectFriend(friend.username));
    avatars.appendChild(button);
  });

  if(online.length>8){
    const more=document.createElement("span");
    more.className="online-more";
    more.textContent="+"+(online.length-8);
    more.title=online.slice(8).map(friend=>friend.username).join(", ");
    avatars.appendChild(more);
  }
}

function showChatItem(button){
  chatList.appendChild(button);
}

function isMobileLayout(){
  return typeof window!=="undefined" && window.matchMedia("(max-width:760px)").matches;
}

function showMobileChat(){
  if(isMobileLayout()){
    sidebar.classList.add("closed");
    el("chatPanel")?.classList.remove("hidden");
  }
}

function showMobileFriendList(){
  if(isMobileLayout()){
    sidebar.classList.remove("closed");
    el("chatPanel")?.classList.remove("hidden");
  }
}

function renderFriendList(){
  chatList.innerHTML="";
  const filter=state.currentFilter;
  const friends=state.friends.filter(friend => {
    if(filter==="groups") return false;
    if(filter==="unread") return Number(friend.unread_count||0)>0;
    return true;
  });
  friends.forEach(friend=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="chat-item"+(friend.username===state.activeFriend?" active":"");
    const presenceClass=friend.online?"online":"offline";
    const presenceText=friend.online?"Online":"Offline";
    const unread=Number(friend.unread_count||0);
    const avatar=escapeHTML(friend.initials||friend.username.slice(0,2).toUpperCase());
    const name=escapeHTML(friend.username);
    const last=friend.last_message?" · "+escapeHTML(friend.last_message):"";
    const time=friend.last_message_time?formatTime(friend.last_message_time):"";
    const badge=unread?"<span class=\"unread-count\">"+(unread>99?"99+":unread)+"</span>":"";
    button.innerHTML="<div class=\"avatar\">"+avatar+"</div>"+
      "<div class=\"chat-meta\"><div class=\"chat-meta-top\"><strong>"+name+"</strong><time>"+time+"</time></div>"+
      "<p><span class=\"friend-presence "+presenceClass+"><i></i>"+presenceText+"</span>"+last+"</p></div>"+badge;
    button.addEventListener("click",()=>selectFriend(friend.username));
    showChatItem(button);
  });

  groups.forEach(group=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="chat-item group-chat-item"+(Number(group.id)===Number(state.activeGroup)?" active":"");
    const avatar=escapeHTML(group.initials||group.name.slice(0,2).toUpperCase());
    const name=escapeHTML(group.name);
    const last=group.last_message?" · "+escapeHTML(group.last_message):"";
    const time=group.last_message_time?formatTime(group.last_message_time):"";
    button.innerHTML="<div class=\"avatar group-avatar\">"+avatar+"</div>"+
      "<div class=\"chat-meta\"><div class=\"chat-meta-top\"><strong>"+name+"</strong><time>"+time+"</time></div>"+
      "<p><span class=\"group-presence\"><i></i>"+Number(group.member_count||0)+" members</span>"+last+"</p></div>";
    button.addEventListener("click",()=>selectGroup(group.id));
    showChatItem(button);
  });

  if(!chatList.children.length && state.friends.length){
    chatList.innerHTML='<div class="empty-friends"><strong>No chats in this filter.</strong><span>Switch back to All to see your conversations.</span></div>';
  }
}
function startFriendRequestRefresh(){
  if(state.friendRequestTimer || !state.token)return;
  state.friendRequestTimer=setInterval(loadFriendRequests,10000);
}

async function loadFriendRequests(){
  try{
    const data=await api("/api/friend-requests");
    state.incomingRequests=data.incoming||[];
    state.outgoingRequests=data.outgoing||[];
    renderFriendRequests();
  }catch{}
}

function renderFriendRequests(){
  const section=el("friendRequestsSection");
  const list=el("requestList");
  const count=el("requestCount");
  if(!section||!list||!count)return;
  const incoming=state.incomingRequests||[];
  section.hidden=incoming.length===0;
  count.textContent=incoming.length===1?"1 waiting":incoming.length+" waiting";
  list.innerHTML="";
  incoming.forEach(request=>{
    const card=document.createElement("article");
    card.className="friend-request-card";
    card.innerHTML="<div class=\"avatar request-avatar\">"+escapeHTML(request.initials||request.username.slice(0,2).toUpperCase())+"</div>"+
      "<div class=\"request-copy\"><strong>"+escapeHTML(request.username)+"</strong><span>wants to be your friend</span></div>"+
      "<div class=\"request-actions\"><button type=\"button\" class=\"request-button accept\">✓</button><button type=\"button\" class=\"request-button reject\">×</button></div>";
    const buttons=card.querySelectorAll("button");
    buttons[0].addEventListener("click",()=>handleFriendRequest(request.id,"accept"));
    buttons[1].addEventListener("click",()=>handleFriendRequest(request.id,"reject"));
    list.appendChild(card);
  });
}

async function handleFriendRequest(requestId,action){
  try{
    await api("/api/friend-requests/"+requestId+"/"+action,{method:"POST"});
    await loadFriendRequests();
    await loadFriends();
    showToast(action==="accept"?"Friend request accepted.":"Friend request declined.");
  }catch(error){showToast(error.message);}
}
function enterFirstChatMode(){
  document.body.classList.add("first-chat-mode");
  state.activeFriend=null;
  state.activeGroup=null;
  state.messages=[];
  el("chatAvatar").textContent="M2";
  el("chatName").textContent="Start your first chat";
  el("chatStatus").textContent="Choose a friend to begin";
  messagesBox.innerHTML='<div class="first-chat-welcome"><div class="first-chat-mark">M2</div><span class="eyebrow">YOUR FIRST CHAT</span><h2>Start a conversation</h2><p>Pick a friend from the left, or add someone new. Your first chat opens here — simple and focused.</p><button type="button" class="first-chat-cta" id="firstChatAddButton">＋ Add a friend</button></div>';
  el("firstChatAddButton")?.addEventListener("click",addFriend);
}
function leaveFirstChatMode(){document.body.classList.remove("first-chat-mode");}
function renderEmptyFriends(){
  enterFirstChatMode();
  chatList.innerHTML='<div class="empty-friends"><strong>No friends yet.</strong><span>Tap ＋ and enter a friend\'s username.</span></div>';
}

function renderTyping(show, username=state.activeFriend){
  const row=el("typingRow");
  const avatar=el("typingRow")?.querySelector(".typing-avatar");
  if(!row)return;
  row.classList.toggle("hidden",!show);
  if(show){
    if(avatar)avatar.textContent=(username||"??").slice(0,2).toUpperCase();
    el("chatStatus").textContent=(username||"Friend")+" is typing…";
  }else if(state.activeFriend){
    const active=state.friends.find(f=>f.username===state.activeFriend);
    if(active)el("chatStatus").textContent=active.online?"Online now":"Offline — messages will be saved";
  }
}

function sendTypingState(typing){
  if(state.socket && state.socket.readyState===WebSocket.OPEN && state.activeFriend){
    try{state.socket.send(JSON.stringify({type:"typing",typing:Boolean(typing)}))}catch{}
  }
}

function formatTime(value){
  if(!value)return "";
  return new Date(Number(value)*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}

async function selectFriend(username){
  if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;}
  if(state.groupPollTimer){clearInterval(state.groupPollTimer);state.groupPollTimer=null;}
  if(state.socket){try{state.socket.close()}catch{} state.socket=null;}
  const loadSeq=++state.chatLoadSeq;
  state.activeGroup=null;
  state.activeFriend=username;
  leaveFirstChatMode();
  state.messages=[];
  renderTyping(false, username);
  renderFriendList();
  const friend=state.friends.find(f=>f.username===username);
  el("chatAvatar").textContent=(friend?.initials||username.slice(0,2)).toUpperCase();
  el("chatName").textContent=username;
  el("chatStatus").textContent="Loading chat…";
  showMobileChat();

  // Paint the chat shell immediately so opening a conversation never looks empty
  // while the history request is in flight.
  const cached=readChatCache("dm",username);
  if(cached.length){state.messages=cached;renderMessages();el("chatStatus").textContent="Loading latest messages…";}
  else messagesBox.innerHTML='<div class="empty-chat chat-loading"><strong>Loading conversation…</strong><span>Fetching your latest messages.</span></div>';

  try{
    const expectedFriend=username;
    const data=await api("/api/messages/"+encodeURIComponent(username));
    if(state.activeFriend!==expectedFriend || loadSeq!==state.chatLoadSeq)return;
    const serverMessages=Array.isArray(data.messages)
      ? data.messages.map(message=>({...message,sender:message.sender||message.username||""}))
      : [];
    state.messages=mergeMessages(readChatCache("dm",username),serverMessages);
    writeChatCache("dm",username,state.messages);
    renderMessages();

    // Force one post-layout render after mobile navigation/animation.
        await api("/api/messages/"+encodeURIComponent(username)+"/read",{method:"POST",body:"{}"}).catch(()=>{});
    const active=state.friends.find(f=>f.username===username);
    if(active)active.unread_count=0;
    renderFriendList();
    connectSocket();
  }catch(error){
    if(state.activeFriend===username){
      messagesBox.innerHTML='<div class="empty-chat"><strong>Could not load this chat.</strong><span>'+escapeHTML(error.message)+'</span></div>';
    }
    showToast(error.message);
  }
}

async function selectGroup(groupId){
  if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;}
  if(state.groupPollTimer){clearInterval(state.groupPollTimer);state.groupPollTimer=null;}
  if(state.socket){try{state.socket.close()}catch{} state.socket=null;}
  ++state.chatLoadSeq;
  state.activeFriend=null;
  state.activeGroup=Number(groupId);
  leaveFirstChatMode();
  renderTyping(false);
  renderFriendList();

  const group=state.groups.find(g=>Number(g.id)===Number(groupId));
  if(!group)return;

  el("chatAvatar").textContent=(group.initials||group.name.slice(0,2)).toUpperCase();
  el("chatName").textContent=group.name;
  el("chatStatus").textContent=Number(group.member_count||0)+" members • group chat";
  showMobileChat();

  try{
    const data=await api("/api/groups/"+group.id+"/messages");
    state.messages=mergeMessages(readChatCache("group",group.id),data.messages||[]);
    writeChatCache("group",group.id,state.messages);
    renderMessages();
    api("/api/groups/"+group.id+"/read",{method:"POST",body:"{}"}).catch(()=>{});
    startGroupPolling();
  }catch(error){
    showToast(error.message);
  }
}


function callSocketSend(payload){
  if(state.callSocket && state.callSocket.readyState===WebSocket.OPEN){
    try{state.callSocket.send(JSON.stringify(payload));return true}catch{}
  }
  return false;
}
function closeCallSocket(){
  if(state.callSocket){try{state.callSocket.close()}catch{}}
  state.callSocket=null;
}
function connectCallSocket(){
  if(!state.token)return;
  if(state.callSocket?.readyState===WebSocket.OPEN || state.callSocket?.readyState===WebSocket.CONNECTING)return;
  const socket=new WebSocket(WS_BASE+"/ws?room=calls&token="+encodeURIComponent(state.token));
  state.callSocket=socket;
  socket.onopen=()=>{if(state.callSocket===socket)state.callSocketRetry=0};
  socket.onmessage=event=>{
    if(state.callSocket!==socket)return;
    try{
      const data=JSON.parse(event.data);
      if(["call-invite","call-accept","call-offer","call-answer","call-ice","call-end","call-reject"].includes(data.type))handleCallSignal(data);
    }catch{}
  };
  socket.onclose=()=>{
    if(state.callSocket!==socket)return;
    state.callSocket=null;
    if(state.token){
      const delay=Math.min(1200*Math.max(1,state.callSocketRetry+1),7000);
      state.callSocketRetry++;
      setTimeout(()=>{if(state.token)connectCallSocket()},delay);
    }
  };
}
function waitForCallSocket(timeout=7000){
  if(state.callSocket?.readyState===WebSocket.OPEN)return Promise.resolve(true);
  if(!state.token)return Promise.resolve(false);
    return new Promise(resolve=>{
    const started=Date.now();
    const timer=setInterval(()=>{
      if(state.callSocket?.readyState===WebSocket.OPEN){clearInterval(timer);resolve(true);return}
      if(Date.now()-started>=timeout){clearInterval(timer);resolve(false)}
    },120);
  });
}
function flushPendingIce(){
  if(!state.rtc?.remoteDescription)return;
  const pending=[...state.pendingIceCandidates];
  state.pendingIceCandidates=[];
  pending.forEach(candidate=>state.rtc.addIceCandidate(candidate).catch(()=>{}));
}

function resetCallUI(){
  clearInterval(state.callTimer);state.callTimer=null;state.callStartedAt=0;
  el("callOverlay")?.classList.add("hidden");
  el("incomingCallOverlay")?.classList.add("hidden");
  const local=el("localVideo"),remote=el("remoteVideo"),audio=el("remoteAudio");
  if(local)local.srcObject=null;if(remote)remote.srcObject=null;if(audio)audio.srcObject=null;
  const stateText=el("callState");if(stateText)stateText.textContent="";
}

function cleanupCall(sendEnd=false){
  if(sendEnd)callSocketSend({type:"call-end"});
  try{state.rtc?.close()}catch{}
  state.rtc=null;
  state.localStream?.getTracks().forEach(track=>track.stop());
  state.localStream=null;
  state.pendingIceCandidates=[];
  state.callMode=null;state.callPeer=null;state.callPeerId=null;state.incomingCall=null;
  resetCallUI();
}

function updateCallTimer(){
  if(!state.callStartedAt)return;
  const seconds=Math.floor((Date.now()-state.callStartedAt)/1000);
  const mm=String(Math.floor(seconds/60)).padStart(2,"0");
  const ss=String(seconds%60).padStart(2,"0");
  if(el("callTimer"))el("callTimer").textContent=mm+":"+ss;
}

async function preparePeer(mode){
  if(!state.callSocket || state.callSocket.readyState!==WebSocket.OPEN) throw new Error("Call connection is not ready.");
  state.callMode=mode;
  state.pendingIceCandidates=[];
  let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
      video:mode==="video"?{facingMode:"user",width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}:false
    });
  }catch(error){
    const reason=error?.name==="NotAllowedError"?"Camera/microphone permission was blocked."
      :error?.name==="NotFoundError"?"No camera or microphone was found."
      :error?.name==="NotReadableError"?"Camera or microphone is busy in another app."
      :"Could not access the "+(mode==="video"?"camera and microphone":"microphone")+".";
    throw new Error(reason+" Check browser permissions and try again.");
  }
  state.localStream=stream;
  let iceServers=[
    {urls:"stun:stun.cloudflare.com:3478"},
    {urls:"stun:stun.l.google.com:19302"}
  ];
  try{
    const ice=await api("/api/call/ice");
    if(Array.isArray(ice.iceServers)&&ice.iceServers.length)iceServers=ice.iceServers;
  }catch{}
  const pc=new RTCPeerConnection({iceServers});
  state.rtc=pc;
  state.localStream.getTracks().forEach(track=>pc.addTrack(track,state.localStream));
  pc.onicecandidate=e=>{if(e.candidate&&state.callPeerId)callSocketSend({type:"call-ice",candidate:e.candidate,to_user_id:state.callPeerId})};
  pc.ontrack=e=>{
    const stream=e.streams[0];
    if(mode==="video"){const video=el("remoteVideo");if(video){video.srcObject=stream;video.play?.().catch(()=>{})}}
    const audio=el("remoteAudio");if(audio){audio.srcObject=stream;audio.play?.().catch(()=>{})}
  };
  pc.onconnectionstatechange=()=>{
    const current=pc.connectionState;
    if(el("callState"))el("callState").textContent=current==="connected"?"Connected":current==="failed"?"Connection failed":current;
    if(current==="connected"&&!state.callStartedAt){state.callStartedAt=Date.now();clearInterval(state.callTimer);state.callTimer=setInterval(updateCallTimer,1000);}
    if(["failed","closed"].includes(current)&&state.rtc===pc){setTimeout(()=>{if(state.rtc===pc)cleanupCall(false)},1500)}
  };
  pc.oniceconnectionstatechange=()=>{
    const ice=pc.iceConnectionState;
    if(ice==="checking"&&el("callState"))el("callState").textContent="Finding secure connection…";
    if(ice==="connected"&&el("callState"))el("callState").textContent="Connected";
    if(ice==="failed"&&el("callState"))el("callState").textContent="Network could not connect";
  };
  if(mode==="video"){
    const local=el("localVideo");if(local){local.srcObject=state.localStream;local.play?.().catch(()=>{})}
  }
  return pc;
}

async function startCall(mode){
  if(!state.activeFriend){showToast("Open a friend chat first.");return}
  if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){showToast("Calls require HTTPS and a supported browser.");return}
  const friend=state.friends.find(item=>item.username===state.activeFriend);
  const targetId=Number(friend?.user_id||0);
  if(!targetId){showToast("Friend details are not loaded yet.");return}
  if(!(await waitForCallSocket())){showToast("Call connection is not ready. Please try again.");return}
  cleanupCall(false);
  try{
    state.callPeer=state.activeFriend;
    state.callPeerId=targetId;
    el("callName").textContent="@"+state.activeFriend;
    el("callAvatar").textContent=state.activeFriend.slice(0,2).toUpperCase();
    el("callState").textContent=mode==="video"?"Requesting camera…":"Requesting microphone…";
    el("callPlaceholder").classList.toggle("hidden",mode==="video");
    el("callOverlay").classList.remove("hidden");
    await preparePeer(mode);
    if(!callSocketSend({type:"call-invite",mode,to_user_id:targetId}))throw new Error("Could not send the call request.");
    el("callState").textContent="Calling…";
  }catch(error){cleanupCall(false);showToast(error.message)}
}

async function acceptIncomingCall(){
  const pending=state.incomingCall;if(!pending)return;
  el("incomingCallOverlay")?.classList.add("hidden");
  try{
    if(!(await waitForCallSocket()))throw new Error("Call connection is not ready.");
    state.callPeer=pending.username;
    state.callPeerId=Number(pending.userId||pending.from_user_id||0);
    await preparePeer(pending.mode);
    el("callName").textContent="@"+pending.username;
    el("callAvatar").textContent=pending.username.slice(0,2).toUpperCase();
    el("callState").textContent=pending.mode==="video"?"Connecting video…":"Connecting voice…";
    el("callPlaceholder").classList.toggle("hidden",pending.mode==="video");
    el("callOverlay").classList.remove("hidden");
    callSocketSend({type:"call-accept",mode:pending.mode,to_user_id:state.callPeerId});
  }catch(error){cleanupCall(false);showToast(error.message)}
}

async function handleCallSignal(data){
  try{
    if(data.type==="call-invite"){
      state.incomingCall={username:data.username,userId:Number(data.from_user_id||0),mode:data.mode||"audio"};
      el("incomingCallName").textContent="@"+data.username;
      el("incomingCallMode").textContent=data.mode==="video"?"Incoming video call":"Incoming voice call";
      el("incomingCallOverlay").classList.remove("hidden");
      return;
    }
    if(data.type==="call-accept" && state.rtc){
      state.callPeer=data.username||state.callPeer;
      const offer=await state.rtc.createOffer();
      await state.rtc.setLocalDescription(offer);
      callSocketSend({type:"call-offer",mode:state.callMode,sdp:offer,to_user_id:state.callPeerId});
      return;
    }
    if(data.type==="call-offer"){
      if(!state.rtc){await preparePeer(data.mode||"audio");}
      await state.rtc.setRemoteDescription(data.sdp);
      flushPendingIce();
      const answer=await state.rtc.createAnswer();
      await state.rtc.setLocalDescription(answer);
      callSocketSend({type:"call-answer",sdp:answer,to_user_id:state.callPeerId});
      return;
    }
    if(data.type==="call-answer"&&state.rtc){await state.rtc.setRemoteDescription(data.sdp);flushPendingIce();return}
    if(data.type==="call-ice"&&data.candidate){
      if(!state.rtc||!state.rtc.remoteDescription){state.pendingIceCandidates.push(data.candidate);return}
      try{await state.rtc.addIceCandidate(data.candidate)}catch{}
      return;
    }
    if(data.type==="call-reject"){showToast("Call declined.");cleanupCall(false);return}
    if(data.type==="call-end"){cleanupCall(false);showToast("Call ended.");return}
  }catch(error){cleanupCall(false);showToast(error.message)}
}

function clearReplyTarget(){
  state.replyTo=null; el("replyBar")?.classList.add("hidden");
  const p=el("replyPreview");if(p)p.textContent="";
}
function setReplyTarget(message){
  state.replyTo=message;
  const bar=el("replyBar"),p=el("replyPreview");
  if(bar&&p){p.textContent=(message.sender||"")+" — "+String(message.body||"").slice(0,90);bar.classList.remove("hidden");}
  input.focus();
}
async function reloadActiveChat(){
  if(state.activeFriend){const data=await api("/api/messages/"+encodeURIComponent(state.activeFriend));state.messages=data.messages||[];}
  else if(state.activeGroup){const data=await api("/api/groups/"+state.activeGroup+"/messages");state.messages=data.messages||[];}
  renderMessages();
}
async function messageAction(message,action,payload={}){
  try{
    const endpoint=state.activeFriend
      ? "/api/messages/"+encodeURIComponent(state.activeFriend)+"/"+message.id+"/"+action
      : "/api/groups/"+state.activeGroup+"/messages/"+message.id+"/"+action;
    await api(endpoint,{method:"POST",body:JSON.stringify(payload)});
    await reloadActiveChat();
  }catch(error){showToast(error.message)}
}
function refreshNotificationPrompt(){
  const card=el("notificationPrompt");
  const button=el("enableNotificationsButton");
  if(!card)return;
  const supported=("Notification" in window) && ("serviceWorker" in navigator);
  const permission=supported?Notification.permission:"unsupported";
  if(permission==="granted"){
    state.notifications=true;
    localStorage.setItem("ajchat_notifications","on");
  }
  card.classList.toggle("hidden",permission!=="default"||!state.token);
  if(button)button.disabled=!supported;
  if(permission==="denied"&&button)button.textContent="Blocked in browser";
  if(permission==="granted"&&button)button.textContent="Notifications enabled";
}

function urlBase64ToUint8Array(base64){
  const padding="=".repeat((4-base64.length%4)%4);
  const raw=atob((base64+padding).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from([...raw].map(char=>char.charCodeAt(0)));
}

async function registerNotifications(){
  if(!("serviceWorker" in navigator))return null;
  try{
    state.notificationRegistration=await navigator.serviceWorker.register("./sw.js",{scope:"./"});
    return state.notificationRegistration;
  }catch{return null}
}

async function syncPushSubscription(){
  if(!state.token || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))return false;
  if(Notification.permission!=="granted")return false;
  const registration=state.notificationRegistration||(await registerNotifications());
  if(!registration) return false;
  await navigator.serviceWorker.ready;
  const config=await api("/api/push/config");
  if(!config.enabled || !config.publicKey){
    throw new Error("Push notifications are not configured on the server yet.");
  }
  let subscription=await registration.pushManager.getSubscription();
  if(!subscription){
    subscription=await registration.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(config.publicKey)
    });
  }
  const payload=subscription.toJSON?subscription.toJSON():JSON.parse(JSON.stringify(subscription));
  await api("/api/push/subscribe",{method:"POST",body:JSON.stringify(payload)});
  return true;
}

async function notifyIncoming(message){
  const enabled=state.notifications || (typeof Notification !== "undefined" && Notification.permission==="granted");
  if(!enabled || !message || message.sender===state.me?.username) return;
  state.notifications=true;
  if(!("Notification" in window) || Notification.permission!=="granted") return;
  if(document.visibilityState==="visible" && (state.activeFriend===message.sender || state.activeGroup || state.socialTab==="global")) return;
  try{
    const registration=state.notificationRegistration||(await navigator.serviceWorker?.ready);
    if(registration?.showNotification){
      await registration.showNotification("AJChat • "+(message.sender||"New message"),{
        body:String(message.body||"").slice(0,120),
        tag:"ajchat-"+String(message.id),
        icon:"./icon.svg",
        badge:"./icon.svg",
        data:{url:"./"}
      });
      if(navigator.setAppBadge) navigator.setAppBadge(1).catch(()=>{});
    }
  }catch{}
}

async function ensureNotifications(){
  if(!("Notification" in window)){showToast("This phone/browser does not support notifications.");return}
  if(Notification.permission==="denied"){showToast("Notifications are blocked in browser settings.");refreshNotificationPrompt();return}
  await registerNotifications();
  const p=Notification.permission==="granted"?"granted":await Notification.requestPermission();
  state.notifications=p==="granted";
  localStorage.setItem("ajchat_notifications",state.notifications?"on":"off");
  if(el("notifyButton"))el("notifyButton").textContent=state.notifications?"♢":"○";
  refreshNotificationPrompt();
  if(state.notifications){
    try{
      await syncPushSubscription();
      showToast("Phone notifications enabled.");
    }catch(error){
      showToast(error.message||"Notification setup needs another try.");
    }
  }else{
    showToast("Notifications disabled.");
  }
}
async function openProfile(username,editable){
  try{
    const data=await api("/api/profile/"+encodeURIComponent(username));const p=data.profile||{};
    el("profileTitle").textContent="@"+data.username;el("profileAvatarPreview").textContent=p.avatar||"✨";
    el("profileAvatar").value=p.avatar||"✨";el("profileStatus").value=p.status||"Available to chat";el("profileBio").value=p.bio||"";
    el("profileStatusPreview").textContent=p.status||"Available to chat";
    ["profileAvatar","profileStatus","profileBio","saveProfileButton"].forEach(id=>{if(el(id))el(id).disabled=!editable});
    el("profileNote").textContent=editable?"Edit your public profile.":"Public profile";el("profileModal").classList.remove("hidden");
  }catch(error){showToast(error.message)}
}
function closeProfile(){el("profileModal")?.classList.add("hidden")}
async function changePassword(){
  const current=prompt("Current password:");if(current===null)return;
  const next=prompt("New password (8+ characters):");if(next===null)return;
  const again=prompt("Repeat new password:");
  if(next!==again){showToast("Passwords do not match.");return}
  try{await api("/api/auth/change-password",{method:"POST",body:JSON.stringify({current_password:current,new_password:next})});showToast("Password changed.");}
  catch(error){showToast(error.message)}
}
async function logoutAllDevices(){
  if(!confirm("Log out AJChat on every device?"))return;
  try{
    await api("/api/auth/logout-all",{method:"POST",body:"{}"});
    localStorage.removeItem("ajchat_token");state.token="";state.me=null;
    if(state.socket){try{state.socket.close()}catch{}}
    closeCallSocket();
    clearReplyTarget();showAuth(true);showToast("Logged out on all devices.");
  }catch(error){showToast(error.message)}
}
async function saveProfile(){
  try{const data=await api("/api/profile",{method:"PUT",body:JSON.stringify({avatar:el("profileAvatar").value.trim()||"✨",status:el("profileStatus").value.trim(),bio:el("profileBio").value.trim()})});el("profileAvatarPreview").textContent=data.profile.avatar;el("profileStatusPreview").textContent=data.profile.status;showToast("Profile saved.");}
  catch(error){showToast(error.message)}
}
function closeHistory(){
  el("historyModal")?.classList.add("hidden");
  el("historyModal")?.setAttribute("aria-hidden","true");
}

function historyMessageMatch(message, query){
  if(!query)return true;
  const needle=query.trim().toLowerCase();
  return String(message.body||"").toLowerCase().includes(needle) ||
    String(message.sender||"").toLowerCase().includes(needle);
}

function renderHistoryList(){
  const list=el("historyList");
  if(!list)return;
  const query=(el("historySearchInput")?.value||"").trim();
  const items=(state.historyMessages||[]).filter(m=>historyMessageMatch(m,query));
  if(!items.length){
    list.innerHTML='<div class="history-empty"><strong>No matching messages.</strong><span>Try another word or clear the search.</span></div>';
    return;
  }
  list.innerHTML=items.slice().reverse().map(message=>{
    const mine=message.sender===state.me?.username;
    const deleted=Boolean(message.deleted_at);
    const body=deleted?"This message was deleted.":String(message.body||"");
    return "<button type='button' class='history-row "+(mine?"mine":"")+"' data-history-id='"+String(message.id)+"'>"+
      "<span class='history-avatar'>"+escapeHTML(String(message.sender||"AJ").slice(0,2).toUpperCase())+"</span>"+
      "<span class='history-row-body'><span class='history-row-top'><strong>"+(mine?"You":"@"+escapeHTML(message.sender||"AJ"))+"</strong><time>"+formatTime(message.created_at)+"</time></span>"+
      "<span class='history-row-text'>"+escapeHTML(body)+"</span></span></button>";
  }).join("");
}

async function openHistory(){
  if(!state.activeFriend && !state.activeGroup){
    showToast("Open a conversation first.");
    return;
  }
  const modal=el("historyModal");
  if(!modal)return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden","false");
  const title=el("historyTitle");
  const subtitle=el("historySubtitle");
  const list=el("historyList");
  const search=el("historySearchInput");
  if(search)search.value="";
  if(state.activeFriend){
    if(title)title.textContent="@"+state.activeFriend;
    if(subtitle)subtitle.textContent="Your recent private messages.";
  }else{
    const group=state.groups.find(g=>Number(g.id)===Number(state.activeGroup));
    if(title)title.textContent=group?.name||"Group history";
    if(subtitle)subtitle.textContent="Your recent group messages.";
  }
  if(list)list.innerHTML='<div class="history-loading">Loading conversation history…</div>';
  try{
    const kind=state.activeFriend?"dm":"group";
    const id=state.activeFriend||state.activeGroup;
    const cached=readChatCache(kind,id);
    const data=state.activeFriend
      ? await api("/api/messages/"+encodeURIComponent(state.activeFriend))
      : await api("/api/groups/"+state.activeGroup+"/messages");
    state.historyMessages=mergeMessages(cached,data.messages||[]);
    writeChatCache(kind,id,state.historyMessages);
    renderHistoryList();
  }catch(error){
    if(list)list.innerHTML='<div class="history-empty"><strong>Could not load history.</strong><span>'+escapeHTML(error.message)+"</span></div>";
  }
}

async function searchCurrentMessages(){
  if(!state.activeFriend){showToast("Open a direct chat to search messages.");return}
  const q=prompt("Search this chat:");if(!q?.trim())return;
  try{const data=await api("/api/messages/"+encodeURIComponent(state.activeFriend)+"/search?q="+encodeURIComponent(q.trim()));state.messages=data.messages||[];renderMessages();showToast(state.messages.length+" matching messages found.");}
  catch(error){showToast(error.message)}
}

function renderMessages(){
  messagesBox.innerHTML="";
  messagesBox.classList.remove("chat-scrolling");
  if(!state.messages.length){messagesBox.innerHTML='<div class="empty-chat"><strong>No messages yet.</strong><span>Say hello — this chat is between real people.</span></div>';return}
  const byId=new Map(state.messages.map(m=>[String(m.id),m]));
  state.messages.forEach((message,index)=>{
    const mine=message.sender===state.me?.username;const row=document.createElement("div");
    row.className="message-row"+(mine?" me":"")+(index < state.messages.length-6 ? " history-message":"");row.dataset.messageId=String(message.id);row.style.animationDelay=(index >= state.messages.length-6 ? ((index-(state.messages.length-6))*18)+"ms" : "0ms");
    const reply=message.reply_to_id?byId.get(String(message.reply_to_id)):null;const deleted=Boolean(message.deleted_at);
    const counts={};(Array.isArray(message.reactions)?message.reactions:[]).forEach(item=>{counts[item.reaction]=(counts[item.reaction]||0)+1});
    const reactions=Object.entries(counts).map(x=>"<span class='reaction-chip'>"+escapeHTML(x[0])+" "+x[1]+"</span>").join("");
    const quote=reply?"<div class='reply-quote'><strong>"+escapeHTML(reply.sender||"")+"</strong><span>"+escapeHTML(String(reply.body||"").slice(0,100))+"</span></div>":"";
    const body=deleted?"This message was deleted.":escapeHTML(message.body||"");
    const status=mine?(message.is_read?"✓✓":"✓"):"";
    row.innerHTML="<article class='message'>"+quote+"<div class='message-text"+(deleted?" deleted":"")+"'>"+body+"</div>"+(reactions?"<div class='reaction-row'>"+reactions+"</div>":"")+"<div class='message-meta'><time>"+formatTime(message.created_at)+(message.edited_at&&!deleted?" · edited":"")+(message.pinned?" · pinned":"")+"</time>"+(mine?"<span class='message-status'>"+status+"</span>":"")+"</div><div class='message-tools'><button type='button' data-action='reply'>↩</button><button type='button' data-action='react' data-reaction='❤️'>❤️</button><button type='button' data-action='react' data-reaction='👍'>👍</button><button type='button' data-action='react' data-reaction='🔥'>🔥</button><button type='button' data-action='pin'>📌</button>"+(mine&&!deleted?"<button type='button' data-action='edit'>✏</button><button type='button' data-action='delete'>🗑</button>":"")+"</div></article>";
    messagesBox.appendChild(row);
  });
  messagesBox.scrollTop=messagesBox.scrollHeight;
  updateScrollControl();
}
function startGroupPolling(){
  if(state.groupPollTimer || !state.activeGroup || !state.token) return;
  const poll=async()=>{
    if(!state.activeGroup || !state.token)return;
    try{
      const data=await api("/api/groups/"+state.activeGroup+"/messages");
      const incoming=data.messages||[];
      const known=new Set(state.messages.map(m=>String(m.id)));
      let changed=false;
      for(const message of incoming){
        if(!known.has(String(message.id))){state.messages.push(message);changed=true;}
      }
      if(changed){
        state.messages=state.messages.slice(-100);
        writeChatCache("group",state.activeGroup,state.messages);
        renderMessages();
      }
    }catch{}
  };
  poll();
  state.groupPollTimer=setInterval(poll,8000);
}

function startPolling(){
  if(state.pollTimer || !state.activeFriend || !state.token) return;
  const poll=async()=>{
    if(!state.activeFriend || !state.token) return;
    try{
      const data=await api("/api/messages/"+encodeURIComponent(state.activeFriend));
      const incoming=data.messages||[];
      const known=new Set(state.messages.map(m=>String(m.id)));
      let changed=false;
      for(const message of incoming){
        if(!known.has(String(message.id))){
          state.messages.push(message); changed=true;
          notifyIncoming(message);
        }
      }
      if(changed){
        state.messages=state.messages.slice(-100);
        writeChatCache("dm",state.activeFriend,state.messages);
        renderMessages();
      }
    }catch{}
  };
  poll();
  state.pollTimer=setInterval(poll,8000);
}

function connectSocket(retry=0){
  if(!state.activeFriend||!state.token)return;
  if(state.socket){try{state.socket.close()}catch{}}
  const expectedFriend=state.activeFriend;
  const room=state.friends.find(f=>f.username===expectedFriend)?.room;
  if(!room){return}
  const socket=new WebSocket(WS_BASE+"/ws?room="+encodeURIComponent(room)+"&token="+encodeURIComponent(state.token));
  state.socket=socket;
  socket.onopen=()=>{
    if(state.socket!==socket || state.activeFriend!==expectedFriend) return;
    if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;}
    el("chatStatus").textContent="online";
  };
  socket.onmessage=(event)=>{
    if(state.socket!==socket || state.activeFriend!==expectedFriend) return;
    try{
      const data=JSON.parse(event.data);
      if(data.type==="typing"){
        renderTyping(Boolean(data.typing), data.username || expectedFriend);
      }
      if(["call-invite","call-accept","call-offer","call-answer","call-ice","call-end","call-reject"].includes(data.type)){
        handleCallSignal(data);
        return;
      }
      if(data.type==="message" && data.message){
        renderTyping(false, expectedFriend);
        if(!state.messages.some(m=>String(m.id)===String(data.message.id))){
          state.messages.push(data.message);
          state.messages=state.messages.slice(-CHAT_CACHE_LIMIT);
          writeChatCache("dm",state.activeFriend,state.messages);
          renderMessages();
          notifyIncoming(data.message);
        }
      }
      if(data.type==="ready"){
        el("chatStatus").textContent=data.online
          ?"Online now"
          :"Offline — messages will be saved";
      }
      if(data.type==="presence"){
        el("chatStatus").textContent=data.online
          ?"Online now"
          :"Offline — messages will be saved";
      }
    }catch{}
  };
  socket.onclose=(event)=>{
    if(state.socket!==socket || state.activeFriend!==expectedFriend) return;
    state.socket=null;
    renderTyping(false, expectedFriend);
    if(document.visibilityState==="hidden") return;
    startPolling();
    el("chatStatus").textContent="Offline — messages will be saved";
    const delay=Math.min(3000*Math.max(1,retry+1),15000);
    setTimeout(()=>{
      if(state.activeFriend===expectedFriend && state.token && document.visibilityState!=="hidden") connectSocket(retry+1);
    },delay);
  };
  socket.onerror=()=>{
    if(state.socket===socket && state.activeFriend===expectedFriend){
      startPolling();
      el("chatStatus").textContent="Offline — messages will be saved";
    }
  };
}

async function sendMessage(){
  const text=input.value.trim();
  if(!text || (!state.activeFriend && !state.activeGroup))return;
  clearTimeout(state.typingTimer);
  state.typingTimer=null;
  sendTypingState(false);

  if(state.activeGroup){
    input.disabled=true;
    try{
      const data=await api("/api/groups/"+state.activeGroup+"/messages",{method:"POST",body:JSON.stringify({text,reply_to_id:state.replyTo?.id||null})});
      if(data.message && !state.messages.some(m=>String(m.id)===String(data.message.id))){
        state.messages.push(data.message);
        state.messages=state.messages.slice(-CHAT_CACHE_LIMIT);
        writeChatCache("group",state.activeGroup,state.messages);
        renderMessages();
      }
      input.value="";
      clearReplyTarget();
      input.focus();
      el("chatStatus").textContent="sent to group";
    }catch(error){
      showToast(error.message);
    }finally{
      input.disabled=false;
      input.focus();
    }
    return;
  }

  const friend=state.activeFriend;
  input.disabled=true;
  try{
    const data=await api("/api/messages/"+encodeURIComponent(friend),{
      method:"POST",
      body:JSON.stringify({text,reply_to_id:state.replyTo?.id||null})
    });

    if(data.message && !state.messages.some(m=>String(m.id)===String(data.message.id))){
      state.messages.push(data.message);
      state.messages=state.messages.slice(-CHAT_CACHE_LIMIT);
      writeChatCache("dm",friend,state.messages);
      renderMessages();
    }

    input.value="";
    clearReplyTarget();
    input.focus();

    if(state.socket && state.socket.readyState===WebSocket.OPEN){
      el("chatStatus").textContent="sent";
      setTimeout(()=>{
        if(state.activeFriend===friend && state.socket?.readyState===WebSocket.OPEN){
          el("chatStatus").textContent="online";
        }
      },900);
    }else{
      startPolling();
      el("chatStatus").textContent="Offline — saved & will deliver";
    }
  }catch(error){
    showToast(error.message);
  }finally{
    input.disabled=false;
    input.focus();
  }
}

async function createGroup(){
  if(!state.me)return;
  const name=prompt("Group name:");
  if(!name || name.trim().length<2)return;
  const members=prompt("Friend usernames, separated by commas:");
  if(!members)return;
  const usernames=members.split(",").map(v=>v.trim()).filter(Boolean);
  if(!usernames.length)return;
  try{
    const data=await api("/api/groups",{method:"POST",body:JSON.stringify({name:name.trim(),usernames})});
    await loadGroups();
    await selectGroup(data.group.id);
    showToast("Group created.");
  }catch(error){
    showToast(error.message);
  }
}

async function addFriend(){
  if(!state.me)return;
  const username=prompt("Enter your friend's AJChat username:");
  if(!username)return;
  try{
    const data=await api("/api/friends",{method:"POST",body:JSON.stringify({username:username.trim()})});
    if(data.status==="friends"){
      await loadFriends();
      await selectFriend(username.trim().toLowerCase());
      showToast("You are already friends.");
      return;
    }
    if(data.status==="incoming"){
      await loadFriendRequests();
      showToast("They already sent you a request. Check Friend requests.");
      return;
    }
    await loadFriendRequests();
    showToast("Friend request sent.");
  }catch(error){
    showToast(error.message);
  }
}

messagesBox?.addEventListener("scroll",updateScrollControl,{passive:true});
ensureScrollControl();
document.querySelectorAll(".social-tab").forEach(button=>button.addEventListener("click",()=>loadSocial(button.dataset.socialTab)));
el("globalChatButton")?.addEventListener("click",()=>loadSocial("global"));
el("enableNotificationsButton")?.addEventListener("click",ensureNotifications);
el("socialProfileButton")?.addEventListener("click",()=>openProfile(state.me?.username,true));
el("socialCloseButton")?.addEventListener("click",closeSocial);
el("socialContent")?.addEventListener("click",async event=>{
  const postButton=event.target.closest("[data-post-action]");if(postButton){const card=postButton.closest("[data-post-id]");if(card)await togglePostAction(Number(card.dataset.postId),postButton.dataset.postAction);return}
  const userButton=event.target.closest("[data-social-user]");if(userButton){await renderProfileSocial(userButton.dataset.socialUser);return}
  const followButton=event.target.closest("[data-follow-user]");if(followButton){await followUser(followButton.dataset.followUser);return}
  const friendButton=event.target.closest("[data-friend-user]");if(friendButton&&!friendButton.disabled){await addFriendUser(friendButton.dataset.friendUser);return}
  if(event.target.id==="globalMessageInput")return;
  const storyButton=event.target.closest("[data-story-view]");if(storyButton){await api("/api/social/stories/"+storyButton.dataset.storyView+"/view",{method:"POST",body:"{}"});showToast("Story marked viewed.");return}
  const storyOpen=event.target.closest("[data-story-id]");if(storyOpen){await loadSocial("stories");return}
  const tabButton=event.target.closest("[data-social-tab]");if(tabButton)await loadSocial(tabButton.dataset.socialTab);
  if(event.target.id==="createPostButton")await createSocialPost();
  if(event.target.id==="refreshSocialButton")await loadSocial(state.socialTab);
});
el("composer").addEventListener("submit",event=>{event.preventDefault();sendMessage()});
el("newChatButton").addEventListener("click",addFriend);
el("backButton").addEventListener("click",()=>{
  if(state.rtc||state.incomingCall)cleanupCall(true);
  if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;}
  if(state.groupPollTimer){clearInterval(state.groupPollTimer);state.groupPollTimer=null;}
  if(state.socket){try{state.socket.close()}catch{} state.socket=null;}
  state.activeFriend=null;
  state.activeGroup=null;
  state.messages=[];
  enterFirstChatMode();
  el("chatName").textContent="Select a friend";
  el("chatStatus").textContent="Tap a name to start chatting";
  showMobileFriendList();
});
document.getElementById("messages")?.addEventListener("click",async event=>{
  const b=event.target.closest("button[data-action]");if(!b)return;const row=b.closest(".message-row");if(!row)return;
  const m=state.messages.find(x=>String(x.id)===row.dataset.messageId);if(!m)return;
  const a=b.dataset.action;
  if(a==="reply"){setReplyTarget(m);return}
  if(a==="react"){await messageAction(m,"react",{reaction:b.dataset.reaction});return}
  if(a==="pin"){await messageAction(m,"pin");return}
  if(a==="edit"){const v=prompt("Edit message:",m.body||"");if(v!==null)await messageAction(m,"edit",{text:v});return}
  if(a==="delete"&&confirm("Delete this message?"))await messageAction(m,"delete");
});
el("cancelReply")?.addEventListener("click",clearReplyTarget);
el("historyButton")?.addEventListener("click",openHistory);
el("historyClose")?.addEventListener("click",closeHistory);
el("historyRefreshButton")?.addEventListener("click",openHistory);
el("historySearchInput")?.addEventListener("input",renderHistoryList);
el("historyList")?.addEventListener("click",event=>{
  const row=event.target.closest("[data-history-id]");
  if(!row)return;
  const id=row.dataset.historyId;
  closeHistory();
  const target=messagesBox.querySelector("[data-message-id='"+CSS.escape(id)+"']");
  if(target){
    target.scrollIntoView({behavior:"smooth",block:"center"});
    target.classList.add("history-focus");
    setTimeout(()=>target.classList.remove("history-focus"),1200);
  }else{
    showToast("That message is outside the currently loaded chat window.");
  }
});
el("chatSearchButton")?.addEventListener("click",searchCurrentMessages);
el("notifyButton")?.addEventListener("click",ensureNotifications);
el("profileClose")?.addEventListener("click",closeProfile);
el("closeProfileButton")?.addEventListener("click",closeProfile);
el("saveProfileButton")?.addEventListener("click",saveProfile);
el("changePasswordButton")?.addEventListener("click",changePassword);
el("logoutAllButton")?.addEventListener("click",logoutAllDevices);
el("chatAvatar")?.addEventListener("click",()=>openProfile(state.activeFriend||state.me?.username,!state.activeFriend));
el("chatMoreButton")?.addEventListener("click",async()=>{
  if(state.activeGroup){
    const choice=prompt("Group options:\n1 = View members\n2 = Add friend\n3 = Rename group\n4 = Leave group");
    try{
      if(choice==="1"){
        const data=await api("/api/groups/"+state.activeGroup);
        const names=(data.group?.members||[]).map(member=>"@"+member.username+(Number(member.online)?" • online":"")).join("\n");
        showToast(names||"No members.");
      }else if(choice==="2"){
        const username=prompt("Friend username to add:");
        if(username){await api("/api/groups/"+state.activeGroup+"/members",{method:"POST",body:JSON.stringify({username})});await loadGroups();await selectGroup(state.activeGroup);showToast("Member added.");}
      }else if(choice==="3"){
        const name=prompt("New group name:");
        if(name){await api("/api/groups/"+state.activeGroup,{method:"PATCH",body:JSON.stringify({name})});await loadGroups();await selectGroup(state.activeGroup);}
      }else if(choice==="4"&&confirm("Leave this group?")){
        const id=state.activeGroup;await api("/api/groups/"+id,{method:"DELETE"});state.activeGroup=null;await loadGroups();renderFriendList();renderEmptyFriends();
      }
    }catch(error){showToast(error.message)}
    return;
  }
  if(state.activeFriend){const c=prompt("Chat options:\n1 = View profile\n2 = Remove friend\n3 = Block user\n4 = Search messages");if(c==="1")await openProfile(state.activeFriend,false);else if(c==="2"&&confirm("Remove @"+state.activeFriend+" from friends?")){const old=state.activeFriend;await api("/api/friends/"+encodeURIComponent(old),{method:"DELETE"});state.activeFriend=null;await loadFriends();renderEmptyFriends();showToast("Friend removed.");}else if(c==="3"&&confirm("Block @"+state.activeFriend+"?")){await api("/api/blocks",{method:"POST",body:JSON.stringify({username:state.activeFriend})});state.activeFriend=null;await loadFriends();renderEmptyFriends()}else if(c==="4")await searchCurrentMessages()}
  else await openProfile(state.me?.username,true);
});

const savedTheme=localStorage.getItem("ajchat_theme");
if(savedTheme==="light")document.body.classList.add("light-mode");
el("themeButton").addEventListener("click",()=>{
  const light=document.body.classList.toggle("light-mode");
  localStorage.setItem("ajchat_theme",light?"light":"dark");
  showToast(light?"Light theme":"Mature dark theme");
});
el("emojiButton").addEventListener("click",()=>el("emojiPanel")?.classList.toggle("hidden"));
el("emojiPanel")?.addEventListener("click",event=>{const b=event.target.closest("button");if(!b)return;input.value+=b.textContent;input.focus();el("emojiPanel").classList.add("hidden")});input.addEventListener("input",()=>{
  if(state.activeGroup || !state.activeFriend)return;
  const typing=input.value.trim().length>0;
  sendTypingState(typing);
  clearTimeout(state.typingTimer);
  if(typing){
    state.typingTimer=setTimeout(()=>{
      sendTypingState(false);
      state.typingTimer=null;
    },1400);
  }
});
input.addEventListener("blur",()=>{
  clearTimeout(state.typingTimer);
  state.typingTimer=null;
  sendTypingState(false);
});

el("attachButton")?.addEventListener("click",()=>showToast("Text chat only — no file storage enabled."));
document.querySelectorAll(".filter-pill").forEach(button=>{
  button.addEventListener("click",()=>{
    document.querySelectorAll(".filter-pill").forEach(item=>item.classList.remove("active"));
    button.classList.add("active");
    state.currentFilter=button.dataset.filter||"all";
    renderFriendList();
  });
});
async function runGlobalSearch(query){
  const panel=el("globalSearchResults");if(!panel)return;
  if(query.length<2){panel.classList.add("hidden");panel.innerHTML="";return}
  try{
    const data=await api("/api/search?q="+encodeURIComponent(query));
    const users=(data.users||[]).slice(0,8);
    const messages=(data.messages||[]).slice(0,10);
    panel.innerHTML="<div class='global-search-head'><strong>Search results</strong><button type='button' id='closeGlobalSearch'>×</button></div>"+
      (users.length?"<div class='global-section-title'>People</div>"+users.map(user=>"<button type='button' class='global-result' data-username='"+escapeHTML(user.username)+"'><span class='avatar'>"+escapeHTML(user.initials||user.username.slice(0,2).toUpperCase())+"</span><span><strong>@"+escapeHTML(user.username)+"</strong><small>AJChat user</small></span></button>").join(""):"")+
      (messages.length?"<div class='global-section-title'>Messages</div>"+messages.map(item=>"<button type='button' class='global-result message-result' data-message-id='"+item.id+"' data-sender='"+escapeHTML(item.sender)+"'><span class='avatar'>⌕</span><span><strong>@"+escapeHTML(item.sender)+"</strong><small>"+escapeHTML(String(item.body||"").slice(0,90))+"</small></span></button>").join(""):"")+
      (!users.length&&!messages.length?"<div class='global-empty'>Nothing found.</div>":"");
    panel.classList.remove("hidden");
    el("closeGlobalSearch")?.addEventListener("click",()=>{panel.classList.add("hidden");panel.innerHTML=""});
    panel.querySelectorAll("[data-username]").forEach(button=>button.addEventListener("click",async()=>{await selectFriend(button.dataset.username);panel.classList.add("hidden");el("chatSearch").value="";}));
  }catch{}
}

el("chatSearch").addEventListener("input",event=>{
  const q=event.target.value.trim().toLowerCase();
  document.querySelectorAll(".chat-item").forEach(item=>item.classList.toggle("hidden",!q||item.textContent.toLowerCase().includes(q)));
  if(q.length>=2)runGlobalSearch(q);else{el("globalSearchResults")?.classList.add("hidden");}
});
document.addEventListener("keydown",event=>{
  if(event.key==="/" && document.activeElement.tagName!=="INPUT"){event.preventDefault();el("chatSearch").focus()}
});

boot();
