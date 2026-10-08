const API_BASE="https://ajchat-api.study4u-aj.workers.dev";
const tokenKey="ajchat_admin_token";
const loginCard=document.getElementById("loginCard");
const dashboard=document.getElementById("dashboard");
const loginForm=document.getElementById("adminForm");
const tokenInput=document.getElementById("adminToken");
const loginStatus=document.getElementById("loginStatus");
const dashboardStatus=document.getElementById("dashboardStatus");
let dashboardTimer=null;

function setLoginStatus(text,error=false){loginStatus.textContent=text||"";loginStatus.className="status"+(error?" error":"")}
function setDashboardStatus(text,error=false){dashboardStatus.textContent=text||"";dashboardStatus.className="dashboard-status"+(error?" error":"")}
function headers(){return {Authorization:"Bearer "+(sessionStorage.getItem(tokenKey)||"")}}
async function searchAdminUsers(){
  const q=document.getElementById("userSearchInput").value.trim();
  const box=document.getElementById("adminUserResults");
  box.innerHTML="<div class='online-empty'>Searching…</div>";
  try{
    const response=await fetch(API_BASE+"/api/admin/users?q="+encodeURIComponent(q),{headers:headers(),cache:"no-store"});
    let data={};try{data=await response.json()}catch{}
    if(response.status===401){setDashboardStatus("Admin token rejected.",true);return}
    if(!response.ok)throw new Error(data.error||"Search failed.");
    box.innerHTML=(data.users||[]).map(user=>{
      const action=user.suspended?"Unsuspend":"Suspend 7d";
      return "<article class='admin-user-row'><div><strong>"+esc(user.username)+"</strong><span>"+(user.online?"🟢 Online":"Offline")+" · "+(user.role||"user")+(user.suspended?" · suspended":"")+"</span></div><div><button type='button' data-admin-action='"+(user.suspended?"unsuspend":"suspend")+"' data-user-id='"+user.id+"'>"+action+"</button><button type='button' class='danger-admin' data-admin-action='delete' data-user-id='"+user.id+"'>Delete</button></div></article>";
    }).join("")||"<div class='online-empty'>No users found.</div>";
  }catch(error){box.innerHTML="<div class='online-empty'>"+esc(error.message)+"</div>"}
}
async function moderateUser(id,action){
  try{
    const response=await fetch(API_BASE+"/api/admin/users/"+id+"/"+action,{method:"POST",headers:headers(),cache:"no-store"});
    let data={};try{data=await response.json()}catch{}
    if(!response.ok)throw new Error(data.error||"Action failed.");
    setDashboardStatus((data.username||"User")+" — "+action+" complete.");
    await searchAdminUsers();await loadDashboard();
  }catch(error){setDashboardStatus(error.message,true)}
}

async function loadDashboard(){
  const response=await fetch(API_BASE+"/api/admin/overview",{headers:headers(),cache:"no-store"});
  let data={};try{data=await response.json()}catch{}
  if(response.status===401){sessionStorage.removeItem(tokenKey);showLogin("Admin token rejected.");return}
  if(!response.ok)throw new Error(data.error||"Dashboard request failed.");
  document.getElementById("usersStat").textContent=Number(data.stats?.users||0).toLocaleString();
  document.getElementById("messagesStat").textContent=Number(data.stats?.messages||0).toLocaleString();
  document.getElementById("messagesTodayStat").textContent=Number(data.stats?.messages_today||0).toLocaleString();
  document.getElementById("usersTodayStat").textContent=Number(data.stats?.users_today||0).toLocaleString();
  document.getElementById("friendshipsStat").textContent=Number(data.stats?.friendships||0).toLocaleString();
  document.getElementById("requestsStat").textContent=Number(data.stats?.pending_requests||0).toLocaleString();

  const chart=document.getElementById("activityChart");
  if(chart){
    const source=new Map((data.daily_messages||[]).map(item=>[item.day,Number(item.count||0)]));
    const days=[]; for(let i=6;i>=0;i--){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-i);days.push(d.toISOString().slice(0,10));}
    const max=Math.max(1,...days.map(day=>source.get(day)||0));
    chart.innerHTML=days.map(day=>{
      const value=source.get(day)||0;
      const label=day.slice(5);
      return "<div class='activity-bar-wrap'><span>"+value+"</span><div class='activity-bar-track'><i style='height:"+Math.max(6,Math.round(value/max*100))+"%'></i></div><small>"+label+"</small></div>";
    }).join("");
  }

  const onlineUsers=data.online_users||[];
  document.getElementById("onlineAdminCount").textContent=String(onlineUsers.length);
  document.getElementById("onlineAdminList").innerHTML=onlineUsers.map(user=>{
    const initials=esc(String(user.username||"").slice(0,2).toUpperCase());
    return "<div class='online-user'><span class='online-user-avatar'>"+initials+"</span><div><strong>"+esc(user.username)+"</strong><span>Online now</span></div><i></i></div>";
  }).join("")||"<div class='online-empty'>No one is online right now.</div>";

  document.getElementById("usersTable").innerHTML=(data.recent_users||[]).map(user=>"<tr><td>"+esc(user.username)+"</td><td>"+date(user.created_at)+"</td></tr>").join("")||"<tr><td colspan='2'>No users yet.</td></tr>";
  document.getElementById("requestsTable").innerHTML=(data.recent_requests||[]).map(item=>"<tr><td>"+esc(item.sender)+"</td><td>"+esc(item.receiver)+"</td><td>"+badge(item.status)+"</td><td>"+date(item.created_at)+"</td></tr>").join("")||"<tr><td colspan='4'>No friend requests yet.</td></tr>";
  setDashboardStatus("Updated "+new Date().toLocaleTimeString());
}
async function makeFriends(event){
  event.preventDefault();
  const status=document.getElementById("forceFriendStatus");
  const userA=document.getElementById("friendUserA").value.trim();
  const userB=document.getElementById("friendUserB").value.trim();
  status.textContent="Connecting…";
  status.className="dashboard-status";
  try{
    const response=await fetch(API_BASE+"/api/admin/friend",{
      method:"POST",
      headers:{...headers(),"Content-Type":"application/json"},
      body:JSON.stringify({username_a:userA,username_b:userB})
    });
    let data={};try{data=await response.json()}catch{}
    if(response.status===401){
      throw new Error("Admin token rejected for this action. Sign in again if your Worker admin token changed.");
    }
    if(!response.ok){
      if(response.status===404){
        throw new Error("Admin friendship API is not deployed yet. Run: cd ~/AJChat/api && npx wrangler deploy");
      }
      throw new Error(data.error||"Could not make friends.");
    }
    status.textContent=data.users[0]+" and "+data.users[1]+" are now friends.";
    document.getElementById("forceFriendForm").reset();
    await loadDashboard();
  }catch(error){
    status.textContent=error.message||"Could not make friends.";
    status.className="dashboard-status error";
  }finally{
    const button=document.querySelector("#forceFriendForm button");
    if(button)button.disabled=false;
  }
}

function badge(status){const safe=esc(status||"unknown");return "<span class='badge "+safe+"'>"+safe+"</span>"}
function date(seconds){if(!seconds)return"—";return new Date(Number(seconds)*1000).toLocaleString([], {day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}
function esc(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function showDashboard(){
  loginCard.classList.add("hidden");dashboard.classList.remove("hidden");
  loadDashboard().catch(e=>setDashboardStatus(e.message,true));
  clearInterval(dashboardTimer);
  dashboardTimer=setInterval(()=>loadDashboard().catch(()=>{}),5000);
}
function showLogin(message=""){
  clearInterval(dashboardTimer);dashboardTimer=null;
  dashboard.classList.add("hidden");loginCard.classList.remove("hidden");setLoginStatus(message,Boolean(message))
}
loginForm.addEventListener("submit",async event=>{
  event.preventDefault();
  const token=tokenInput.value.trim();if(!token)return;
  sessionStorage.setItem(tokenKey,token);setLoginStatus("Checking…");
  try{await loadDashboard();if(sessionStorage.getItem(tokenKey))showDashboard()}catch(error){sessionStorage.removeItem(tokenKey);setLoginStatus(error.message,true)}
});
document.getElementById("forceFriendForm").addEventListener("submit",makeFriends);
document.getElementById("userSearchButton").addEventListener("click",searchAdminUsers);
document.getElementById("userSearchInput").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();searchAdminUsers()}});
document.getElementById("adminUserResults").addEventListener("click",event=>{
  const button=event.target.closest("button[data-admin-action]");if(!button)return;
  const action=button.dataset.adminAction,id=button.dataset.userId;
  if(action==="delete"&&!confirm("Delete this account permanently?"))return;
  moderateUser(id,action);
});

document.getElementById("refreshButton").addEventListener("click",()=>loadDashboard().catch(e=>setDashboardStatus(e.message,true)));
document.getElementById("logoutButton").addEventListener("click",()=>{sessionStorage.removeItem(tokenKey);tokenInput.value="";showLogin("Locked.")});
if(sessionStorage.getItem(tokenKey))showDashboard();
