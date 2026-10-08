const CACHE="ajchat-shell-v9";
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/AJChat/","/AJChat/index.html","/AJChat/styles.css","/AJChat/app.js?v=20261007-forestfast","/AJChat/manifest.json","/AJChat/icon.svg"])).then(()=>self.skipWaiting()))});
self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});
self.addEventListener("push",event=>{
  let data={title:"AJChat",body:"You have a new message.",url:"/AJChat/"};
  try{data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:"/AJChat/icon.svg",badge:"/AJChat/icon.svg",tag:data.tag||"ajchat",data:{url:data.url||"/AJChat/"},renotify:true}));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    const target=list.find(client=>client.url.includes("/AJChat/"));
    if(target){target.focus();return target.navigate(event.notification.data?.url||"/AJChat/");}
    return clients.openWindow(event.notification.data?.url||"/AJChat/");
  }));
});