const CACHE="m2-shell-v1";
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(["/m2/","/m2/index.html","/m2/styles.css","/m2/app.js?v=20261007-forestfast","/m2/manifest.json","/m2/icon.svg"])).then(()=>self.skipWaiting()))});
self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});
self.addEventListener("push",event=>{
  let data={title:"m2",body:"You have a new message.",url:"/m2/"};
  try{data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:"/m2/icon.svg",badge:"/m2/icon.svg",tag:data.tag||"ajchat",data:{url:data.url||"/m2/"},renotify:true}));
});
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
    const target=list.find(client=>client.url.includes("/m2/"));
    if(target){target.focus();return target.navigate(event.notification.data?.url||"/m2/");}
    return clients.openWindow(event.notification.data?.url||"/m2/");
  }));
});