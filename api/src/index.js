import { DurableObject } from "cloudflare:workers";
import { sendPushNotification } from "@mmmike/web-push/send";

const enc = new TextEncoder();

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === "https://aj-8a.github.io" || origin.startsWith("http://localhost:");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://aj-8a.github.io",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  };
}

function json(request, data, status = 200) {
  return Response.json(data, { status, headers: corsHeaders(request) });
}

function cleanUsername(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 24)
    : "";
}

function cleanMessage(value) {
  return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}

function roomFor(a, b) {
  const ids = [Number(a), Number(b)].sort((x, y) => x - y);
  return `dm:${ids[0]}:${ids[1]}`;
}

function hex(bytes) {
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return hex(data);
}

async function hashPassword(password, saltBytes = null) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `${hex(salt)}:${hex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, expected] = String(stored || "").split(":");
  if (!saltHex || !expected) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(x => parseInt(x, 16)));
  const actual = await hashPassword(password, salt);
  return constantTime(actual.split(":")[1], expected);
}

function constantTime(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function bodyJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function authUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const row = await env.AJCHAT_DB
    .prepare(`
      SELECT u.id, u.username, COALESCE(uc.role, 'user') AS role,
             COALESCE(uc.suspended_until, 0) AS suspended_until
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN user_controls uc ON uc.user_id = u.id
      WHERE s.token = ? AND s.expires_at > ?
    `)
    .bind(token, now)
    .first();

  if (!row || Number(row.suspended_until || 0) > now) return null;
  return row;
}

function initials(username) {
  return String(username || "").slice(0, 2).toUpperCase();
}

async function isBlocked(db, a, b) {
  return Boolean(await db.prepare("SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)").bind(a, b, b, a).first());
}

function parseReactions(value) {
  try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function cleanProfileText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function ensureProfile(db, userId) {
  await db.prepare("INSERT OR IGNORE INTO profiles (user_id) VALUES (?)").bind(userId).run();
  return db.prepare("SELECT user_id, bio, status, avatar, updated_at FROM profiles WHERE user_id = ?").bind(userId).first();
}

function adminAuthorized(request, env) {
  const configured = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN : "";
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return Boolean(configured && provided && constantTime(provided, configured));
}

async function isFriend(db, userId, friendId) {
  return Boolean(await db
    .prepare("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?")
    .bind(userId, friendId)
    .first());
}

async function socialNotify(db,{userId,actorId,type,postId=null,storyId=null,body}) {
  if (Number(userId) === Number(actorId)) return;
  await db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id, story_id, body) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, actorId || null, type, postId, storyId, cleanProfileText(body, 180)).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(request, { ok: true, service: "AJChat API" });
      }

      if (url.pathname === "/api/version" && request.method === "GET") {
        return json(request, { ok: true, version: "ajchat-pro-1", build: "2026-10-05" });
      }

      if (url.pathname === "/api/admin/overview" && request.method === "GET") {
        if (!adminAuthorized(request, env)) {
          return json(request, { error: "Unauthorized" }, 401);
        }

        const [users, messages, friendships, pendingRequests, messagesToday, usersToday, dailyMessages, recentUsers, recentRequests, onlineUsers] = await Promise.all([
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM users").first(),
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM friendships").first(),
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM friend_requests WHERE status = 'pending'").first(),
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE created_at >= unixepoch('now','start of day')").first(),
          env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM users WHERE created_at >= unixepoch('now','start of day')").first(),
          env.AJCHAT_DB.prepare("SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day, COUNT(*) AS count FROM messages WHERE created_at >= unixepoch('now','-6 days','start of day') GROUP BY day ORDER BY day").all(),
          env.AJCHAT_DB.prepare("SELECT id, username, created_at FROM users ORDER BY id DESC LIMIT 20").all(),
          env.AJCHAT_DB.prepare("SELECT r.id, r.status, r.created_at, sender.username AS sender, receiver.username AS receiver FROM friend_requests r JOIN users sender ON sender.id = r.sender_id JOIN users receiver ON receiver.id = r.receiver_id ORDER BY r.id DESC LIMIT 20").all(),
          env.AJCHAT_DB.prepare("SELECT u.id, u.username, p.last_seen FROM user_presence p JOIN users u ON u.id = p.user_id WHERE p.last_seen >= unixepoch() - 45 ORDER BY p.last_seen DESC, u.username COLLATE NOCASE").all()
        ]);

        return json(request, {
          stats: {
            users: Number(users?.count || 0),
            messages: Number(messages?.count || 0),
            friendships: Number(friendships?.count || 0),
            pending_requests: Number(pendingRequests?.count || 0),
            messages_today: Number(messagesToday?.count || 0),
            users_today: Number(usersToday?.count || 0)
          },
          daily_messages: (dailyMessages.results || []).map(row => ({day: row.day, count: Number(row.count || 0)})),
          recent_users: recentUsers.results || [],
          recent_requests: recentRequests.results || [],
          online_users: (onlineUsers.results || []).map(user => ({
            id: Number(user.id),
            username: user.username,
            last_seen: Number(user.last_seen || 0)
          }))
        });
      }
      if (url.pathname === "/api/admin/users" && request.method === "GET") {
        if (!adminAuthorized(request, env)) return json(request,{error:"Unauthorized"},401);
        const q=cleanProfileText(url.searchParams.get("q"),40);
        const rows=await env.AJCHAT_DB.prepare("SELECT u.id,u.username,u.created_at,COALESCE(uc.role,'user') AS role,COALESCE(uc.suspended_until,0) AS suspended_until,CASE WHEN COALESCE(p.last_seen,0)>=unixepoch()-45 THEN 1 ELSE 0 END AS online FROM users u LEFT JOIN user_controls uc ON uc.user_id=u.id LEFT JOIN user_presence p ON p.user_id=u.id WHERE ?='' OR u.username LIKE ? COLLATE NOCASE ORDER BY u.id DESC LIMIT 50").bind(q,"%"+q+"%").all();
        return json(request,{users:(rows.results||[]).map(row=>({...row,id:Number(row.id),online:Boolean(Number(row.online)),suspended:Boolean(Number(row.suspended_until||0))}))});
      }

      const adminUserControl=url.pathname.match(/^\/api\/admin\/users\/(\d+)\/(suspend|unsuspend|delete)$/);
      if(adminUserControl && request.method==="POST"){
        if(!adminAuthorized(request,env))return json(request,{error:"Unauthorized"},401);
        const targetId=Number(adminUserControl[1]),action=adminUserControl[2];
        const target=await env.AJCHAT_DB.prepare("SELECT id,username FROM users WHERE id=?").bind(targetId).first();
        if(!target)return json(request,{error:"User not found."},404);
        if(action==="delete"){await env.AJCHAT_DB.prepare("DELETE FROM users WHERE id=?").bind(targetId).run();return json(request,{ok:true,deleted:target.username});}
        await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO user_controls(user_id) VALUES(?)").bind(targetId).run();
        const until=action==="suspend"?Math.floor(Date.now()/1000)+60*60*24*7:0;
        await env.AJCHAT_DB.prepare("UPDATE user_controls SET suspended_until=?,updated_at=unixepoch() WHERE user_id=?").bind(until,targetId).run();
        if(action==="suspend")await env.AJCHAT_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(targetId).run();
        return json(request,{ok:true,action,username:target.username,suspended_until:until});
      }
      if (url.pathname === "/api/admin/friend" && request.method === "POST") {
        if (!adminAuthorized(request, env)) {
          return json(request, { error: "Unauthorized" }, 401);
        }

        const body = await bodyJson(request);
        const usernameA = cleanUsername(body.username_a);
        const usernameB = cleanUsername(body.username_b);

        if (!usernameA || !usernameB) {
          return json(request, { error: "Enter both usernames." }, 400);
        }
        if (usernameA === usernameB) {
          return json(request, { error: "Choose two different users." }, 400);
        }

        const users = await env.AJCHAT_DB
          .prepare("SELECT id, username FROM users WHERE lower(username) IN (?, ?)")
          .bind(usernameA, usernameB)
          .all();

        const found = users.results || [];
        if (found.length !== 2) {
          const foundNames = new Set(found.map(row => String(row.username).toLowerCase()));
          const missing = [usernameA, usernameB].filter(name => !foundNames.has(name));
          return json(request, { error: "User not found: " + missing.join(", ") }, 404);
        }

        const first = found.find(row => String(row.username).toLowerCase() === usernameA);
        const second = found.find(row => String(row.username).toLowerCase() === usernameB);

        await env.AJCHAT_DB.batch([
          env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)").bind(first.id, second.id),
          env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)").bind(second.id, first.id),
          env.AJCHAT_DB.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = unixepoch() WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)").bind(first.id, second.id, second.id, first.id)
        ]);

        return json(request, {
          ok: true,
          status: "friends",
          users: [first.username, second.username]
        });
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const body = await bodyJson(request);
        const username = cleanUsername(body.username);
        const password = typeof body.password === "string" ? body.password : "";

        if (username.length < 3) {
          return json(request, { error: "Username must be at least 3 characters." }, 400);
        }
        if (password.length < 8) {
          return json(request, { error: "Password must be at least 8 characters." }, 400);
        }

        const existing = await env.AJCHAT_DB
          .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
          .bind(username)
          .first();

        if (existing) {
          return json(request, { error: "That username is already taken." }, 409);
        }

        const passwordHash = await hashPassword(password);
        const inserted = await env.AJCHAT_DB
          .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
          .bind(username, passwordHash)
          .run();

        const userId = inserted.meta?.last_row_id;
        const token = randomToken();
        const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

        await env.AJCHAT_DB
          .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
          .bind(token, userId, expires)
          .run();
        await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO user_controls (user_id) VALUES (?)").bind(userId).run();

        return json(request, { token, user: { id: userId, username, initials: initials(username) } }, 201);
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await bodyJson(request);
        const username = cleanUsername(body.username);
        const password = typeof body.password === "string" ? body.password : "";

        const user = await env.AJCHAT_DB
          .prepare("SELECT u.id, u.username, u.password_hash, COALESCE(uc.suspended_until,0) AS suspended_until FROM users u LEFT JOIN user_controls uc ON uc.user_id=u.id WHERE u.username = ? COLLATE NOCASE")
          .bind(username)
          .first();

        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return json(request, { error: "Incorrect username or password." }, 401);
        }
        if (Number(user.suspended_until || 0) > Math.floor(Date.now()/1000)) {
          return json(request, { error: "This account is temporarily suspended." }, 403);
        }

        const token = randomToken();
        const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

        await env.AJCHAT_DB
          .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
          .bind(token, user.id, expires)
          .run();
        await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO user_controls (user_id) VALUES (?)").bind(user.id).run();

        return json(request, {
          token,
          user: { id: user.id, username: user.username, initials: initials(user.username) }
        });
      }

      if (url.pathname === "/ws" && request.method === "GET" && request.headers.get("Upgrade") === "websocket") {
        const token = url.searchParams.get("token") || "";
        const room = url.searchParams.get("room") || "";
        if (!token || !room) return new Response("Missing credentials", { status: 400 });

        const sessionRequest = new Request(request.url, {
          headers: { Authorization: "Bearer " + token }
        });
        const wsUser = await authUser(sessionRequest, env);
        if (!wsUser) return new Response("Unauthorized", { status: 401 });

        const parts = room.split(":");
        const validSpecialRoom = room === "global" || room === "calls";
        if (!validSpecialRoom && (parts.length !== 3 || parts[0] !== "dm")) return new Response("Invalid room", { status: 400 });

        if (room.startsWith("dm:")) {
          const a = Number(parts[1]);
          const b = Number(parts[2]);
          if (![a, b].includes(Number(wsUser.id))) return new Response("Forbidden", { status: 403 });

          const otherId = Number(wsUser.id) === a ? b : a;
          if (!(await isFriend(env.AJCHAT_DB, wsUser.id, otherId))) {
            return new Response("Not friends", { status: 403 });
          }
        }

        const objectId = env.CHAT_ROOMS.idFromName(room);
        const stub = env.CHAT_ROOMS.get(objectId);
        const headers = new Headers(request.headers);
        headers.set("x-ajchat-user-id", String(wsUser.id));
        headers.set("x-ajchat-username", wsUser.username);
        return stub.fetch(new Request(request, { headers }));
      }

      const user = await authUser(request, env);

      if (url.pathname === "/api/me" && request.method === "GET") {
        if (!user) return json(request, { error: "Unauthorized" }, 401);
        return json(request, { id: user.id, username: user.username, initials: initials(user.username) });
      }

      if (!user) {
        return json(request, { error: "Authentication required." }, 401);
      }

      if (url.pathname === "/api/push/config" && request.method === "GET") {
        const publicKey = typeof env.VAPID_PUBLIC_KEY === "string" ? env.VAPID_PUBLIC_KEY.trim() : "";
        return json(request, { enabled: Boolean(publicKey), publicKey });
      }

      if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
        const body = await bodyJson(request);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim().slice(0, 2000) : "";
        const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh.trim().slice(0, 500) : "";
        const auth = typeof body.keys?.auth === "string" ? body.keys.auth.trim().slice(0, 500) : "";
        if (!endpoint || !p256dh || !auth) return json(request, { error: "Invalid push subscription." }, 400);
        await env.AJCHAT_DB.prepare(
          "INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,updated_at) VALUES(?,?,?,?,unixepoch()) " +
          "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=unixepoch()"
        ).bind(user.id, endpoint, p256dh, auth).run();
        return json(request, { ok: true });
      }

      if (url.pathname === "/api/push/subscribe" && request.method === "DELETE") {
        const body = await bodyJson(request);
        const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
        if (endpoint) await env.AJCHAT_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(endpoint, user.id).run();
        return json(request, { ok: true });
      }

      if (url.pathname === "/api/call/ice" && request.method === "GET") {
        if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
          return json(request, {
            iceServers: [
              { urls: "stun:stun.cloudflare.com:3478" },
              { urls: "stun:stun.l.google.com:19302" }
            ],
            turnAvailable: false
          });
        }

        const turnResponse = await fetch(
          "https://rtc.live.cloudflare.com/v1/turn/keys/" +
            encodeURIComponent(env.TURN_KEY_ID) +
            "/credentials/generate-ice-servers",
          {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.TURN_API_TOKEN,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ ttl: 3600 })
          }
        );

        if (!turnResponse.ok) {
          return json(request, { error: "TURN credentials could not be generated." }, 502);
        }

        const data = await turnResponse.json();
        const iceServers = Array.isArray(data.iceServers) ? data.iceServers : [];
        return json(request, { iceServers, turnAvailable: iceServers.some(server => String(server.urls || "").includes("turn:") || Array.isArray(server.urls) && server.urls.some(url => String(url).startsWith("turn"))) });
      }

      if (url.pathname === "/api/presence" && request.method === "POST") {
        const now = Math.floor(Date.now() / 1000);
        const previous = await env.AJCHAT_DB
          .prepare("SELECT last_seen FROM user_presence WHERE user_id=?")
          .bind(user.id)
          .first();
        const wasOffline = !previous || Number(previous.last_seen || 0) < now - 45;

        await env.AJCHAT_DB
          .prepare(`
            INSERT INTO user_presence (user_id, last_seen)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen
          `)
          .bind(user.id, now)
          .run();

        if (wasOffline) {
          ctx.waitUntil(pushNotifyFriendsOnline(env, user.id, user.username));
        }

        return json(request, { ok: true, online: true });
      }

      if (url.pathname === "/api/friends" && request.method === "GET") {
        const rows = await env.AJCHAT_DB
          .prepare(`
            SELECT
              u.username,
              u.id AS user_id,
              substr(upper(u.username), 1, 2) AS initials,
              CASE WHEN COALESCE(p.last_seen, 0) >= unixepoch() - 45 THEN 1 ELSE 0 END AS online,
              (
                SELECT body FROM messages m
                WHERE m.room_id = CASE
                  WHEN ? < u.id THEN 'dm:' || ? || ':' || u.id
                  ELSE 'dm:' || u.id || ':' || ?
                END
                ORDER BY m.id DESC LIMIT 1
              ) AS last_message,
              (
                SELECT created_at FROM messages m
                WHERE m.room_id = CASE
                  WHEN ? < u.id THEN 'dm:' || ? || ':' || u.id
                  ELSE 'dm:' || u.id || ':' || ?
                END
                ORDER BY m.id DESC LIMIT 1
              ) AS last_message_time,
              (
                SELECT COUNT(*)
                FROM messages m
                WHERE m.room_id = CASE
                  WHEN ? < u.id THEN 'dm:' || ? || ':' || u.id
                  ELSE 'dm:' || u.id || ':' || ?
                END
                  AND m.sender_id = u.id
                  AND m.recipient_id = ?
                  AND m.id > COALESCE((
                    SELECT last_read_message_id
                    FROM friend_read_state rs
                    WHERE rs.user_id = ? AND rs.friend_id = u.id
                  ), 0)
              ) AS unread_count
            FROM friendships f
            JOIN users u ON u.id = f.friend_id
            LEFT JOIN user_presence p ON p.user_id = u.id
            WHERE f.user_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM blocks b
                WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
                   OR (b.blocker_id = u.id AND b.blocked_id = ?)
              )
            ORDER BY COALESCE(last_message_time, 0) DESC, u.username COLLATE NOCASE
          `)
          .bind(
            user.id,user.id,user.id,
            user.id,user.id,user.id,
            user.id,user.id,user.id,user.id,user.id,
            user.id,user.id,user.id
          )
          .all();

        const friends = (rows.results || []).map(friend => ({
          ...friend,
          online: Boolean(Number(friend.online)),
          unread_count: Number(friend.unread_count || 0),
          room: roomFor(user.id, friend.user_id)
        }));

        return json(request, { friends });
      }

      if (url.pathname === "/api/friends" && request.method === "POST") {
        const body = await bodyJson(request);
        const friendUsername = cleanUsername(body.username);

        if (!friendUsername) return json(request, { error: "Enter a valid username." }, 400);
        if (friendUsername === user.username.toLowerCase()) {
          return json(request, { error: "You cannot add yourself." }, 400);
        }

        const friend = await env.AJCHAT_DB
          .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
          .bind(friendUsername)
          .first();

        if (!friend) return json(request, { error: "No AJChat user found with that username." }, 404);

        if (await isFriend(env.AJCHAT_DB, user.id, friend.id)) {
          return json(request, { ok: true, status: "friends", friend: { username: friend.username, room: roomFor(user.id, friend.id) } });
        }

        const existing = await env.AJCHAT_DB
          .prepare("SELECT id, sender_id, receiver_id, status FROM friend_requests WHERE sender_id = ? AND receiver_id = ?")
          .bind(user.id, friend.id)
          .first();

        if (existing?.status === "pending") {
          return json(request, { ok: true, status: "pending", request_id: existing.id });
        }

        const reverse = await env.AJCHAT_DB
          .prepare("SELECT id, status FROM friend_requests WHERE sender_id = ? AND receiver_id = ?")
          .bind(friend.id, user.id)
          .first();

        if (reverse?.status === "pending") {
          return json(request, { ok: true, status: "incoming", request_id: reverse.id });
        }

        let requestId;
        if (existing) {
          await env.AJCHAT_DB
            .prepare("UPDATE friend_requests SET status = 'pending', updated_at = unixepoch() WHERE id = ?")
            .bind(existing.id)
            .run();
          requestId = existing.id;
        } else {
          const inserted = await env.AJCHAT_DB
            .prepare("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES (?, ?, 'pending')")
            .bind(user.id, friend.id)
            .run();
          requestId = Number(inserted.meta?.last_row_id || 0);
        }

        await pushNotifyUser(env, friend.id, {
          title: "New friend request",
          body: "@" + user.username + " sent you a friend request.",
          url: "/AJChat/",
          tag: "friend-request-" + requestId
        }).catch(() => {});
        return json(request, { ok: true, status: "pending", request_id: requestId, to: friend.username }, 201);
      }


      if (url.pathname === "/api/groups" && request.method === "GET") {
        const rows = await env.AJCHAT_DB.prepare(`
          SELECT
            g.id,
            g.name,
            g.created_at,
            substr(upper(g.name), 1, 2) AS initials,
            (SELECT body FROM messages m WHERE m.room_id = 'group:' || g.id ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages m WHERE m.room_id = 'group:' || g.id ORDER BY m.id DESC LIMIT 1) AS last_message_time,
            (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count
          FROM groups g
          JOIN group_members gm ON gm.group_id = g.id
          WHERE gm.user_id = ?
          ORDER BY COALESCE(last_message_time, 0) DESC, g.name COLLATE NOCASE
        `).bind(user.id).all();

        return json(request, {
          groups: (rows.results || []).map(group => ({
            ...group,
            id: Number(group.id),
            member_count: Number(group.member_count || 0),
            room: "group:" + group.id
          }))
        });
      }


      const groupControlMatch = url.pathname.match(/^\/api\/groups\/(\d+)(?:\/members(?:\/([^/]+))?)?$/);
      if (groupControlMatch && (request.method === "GET" || request.method === "PATCH" || request.method === "POST" || request.method === "DELETE")) {
        const groupId = Number(groupControlMatch[1]);
        const memberUsername = groupControlMatch[2] ? decodeURIComponent(groupControlMatch[2]) : "";
        const group = await env.AJCHAT_DB.prepare("SELECT id,name,owner_id FROM groups WHERE id=?").bind(groupId).first();
        if(!group)return json(request,{error:"Group not found."},404);
        const membership = await env.AJCHAT_DB.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").bind(groupId,user.id).first();
        if(!membership)return json(request,{error:"You are not a member of this group."},403);

        if(request.method==="GET" && !memberUsername){
          const members = await env.AJCHAT_DB.prepare("SELECT u.id,u.username,substr(upper(u.username),1,2) AS initials,CASE WHEN COALESCE(p.last_seen,0)>=unixepoch()-45 THEN 1 ELSE 0 END AS online FROM group_members gm JOIN users u ON u.id=gm.user_id LEFT JOIN user_presence p ON p.user_id=u.id WHERE gm.group_id=? ORDER BY CASE WHEN u.id=? THEN 0 ELSE 1 END,u.username COLLATE NOCASE").bind(groupId,user.id).all();
          return json(request,{group:{...group,id:Number(group.id),members:members.results||[]}});
        }

        if(request.method==="PATCH"){
          if(Number(group.owner_id)!==Number(user.id))return json(request,{error:"Only the group owner can rename the group."},403);
          const body=await bodyJson(request);const name=typeof body.name==="string"?body.name.trim().slice(0,40):"";
          if(name.length<2)return json(request,{error:"Group name must be at least 2 characters."},400);
          await env.AJCHAT_DB.prepare("UPDATE groups SET name=? WHERE id=?").bind(name,groupId).run();
          return json(request,{ok:true,name});
        }

        if(request.method==="POST"){
          if(Number(group.owner_id)!==Number(user.id))return json(request,{error:"Only the group owner can add members."},403);
          const body=await bodyJson(request);const username=cleanUsername(body.username);
          const target=await env.AJCHAT_DB.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
          if(!target)return json(request,{error:"User not found."},404);
          if(!(await isFriend(env.AJCHAT_DB,user.id,target.id)))return json(request,{error:"You must be friends before adding this user."},403);
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)").bind(groupId,target.id).run();
          return json(request,{ok:true,username:target.username});
        }

        if(request.method==="DELETE"){
          if(memberUsername){
            if(Number(group.owner_id)!==Number(user.id))return json(request,{error:"Only the group owner can remove members."},403);
            const target=await env.AJCHAT_DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(memberUsername).first();
            if(!target)return json(request,{error:"User not found."},404);
            await env.AJCHAT_DB.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").bind(groupId,target.id).run();
            return json(request,{ok:true,removed:true});
          }
          const others=await env.AJCHAT_DB.prepare("SELECT user_id FROM group_members WHERE group_id=? AND user_id<>? ORDER BY joined_at LIMIT 1").bind(groupId,user.id).first();
          if(Number(group.owner_id)===Number(user.id) && others){
            await env.AJCHAT_DB.prepare("UPDATE groups SET owner_id=? WHERE id=?").bind(others.user_id,groupId).run();
          }else if(Number(group.owner_id)===Number(user.id) && !others){
            await env.AJCHAT_DB.prepare("DELETE FROM groups WHERE id=?").bind(groupId).run();
            return json(request,{ok:true,deleted:true});
          }
          await env.AJCHAT_DB.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").bind(groupId,user.id).run();
          return json(request,{ok:true,left:true});
        }
      }

      if (url.pathname === "/api/groups" && request.method === "POST") {
        const body = await bodyJson(request);
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
        const rawMembers = Array.isArray(body.usernames) ? body.usernames : [];
        const usernames = [...new Set(rawMembers.map(cleanUsername).filter(Boolean))];

        if (name.length < 2) return json(request, { error: "Group name must be at least 2 characters." }, 400);
        if (!usernames.length) return json(request, { error: "Add at least one friend to the group." }, 400);

        const members = [];
        for (const username of usernames) {
          if (username === user.username.toLowerCase()) continue;
          const person = await env.AJCHAT_DB
            .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
            .bind(username)
            .first();

          if (!person) return json(request, { error: 'No AJChat user found with username "' + username + '".' }, 404);
          if (!(await isFriend(env.AJCHAT_DB, user.id, person.id))) {
            return json(request, { error: "You must be friends with @" + person.username + " before adding them to a group." }, 403);
          }
          members.push(person);
        }

        if (!members.length) return json(request, { error: "Choose at least one friend besides yourself." }, 400);

        const inserted = await env.AJCHAT_DB
          .prepare("INSERT INTO groups (name, owner_id) VALUES (?, ?)")
          .bind(name, user.id)
          .run();

        const groupId = Number(inserted.meta?.last_row_id || 0);
        const memberStatements = [
          env.AJCHAT_DB.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").bind(groupId, user.id),
          ...members.map(person => env.AJCHAT_DB.prepare("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)").bind(groupId, person.id))
        ];
        await env.AJCHAT_DB.batch(memberStatements);

        return json(request, {
          ok: true,
          group: {
            id: groupId,
            name,
            initials: initials(name),
            member_count: members.length + 1,
            room: "group:" + groupId
          }
        }, 201);
      }

      const groupMessageControl = url.pathname.match(/^\/api\/groups\/(\d+)\/messages\/(\d+)\/(edit|delete|react|pin)$/);
      if (groupMessageControl && request.method === "POST") {
        const groupId=Number(groupMessageControl[1]), messageId=Number(groupMessageControl[2]), action=groupMessageControl[3];
        const member=await env.AJCHAT_DB.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").bind(groupId,user.id).first();
        if(!member)return json(request,{error:"Group not found."},404);
        const message=await env.AJCHAT_DB.prepare("SELECT id,sender_id FROM messages WHERE id=? AND room_id=?").bind(messageId,"group:"+groupId).first();
        if(!message)return json(request,{error:"Message not found."},404);
        if(action!=="react"&&Number(message.sender_id)!==Number(user.id))return json(request,{error:"Only the sender can change this message."},403);
        if(action==="edit"){
          const body=await bodyJson(request);const next=cleanMessage(body.text);if(!next)return json(request,{error:"Message cannot be empty."},400);
          await env.AJCHAT_DB.prepare("UPDATE messages SET body=? WHERE id=?").bind(next,messageId).run();
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET edited_at=unixepoch(),deleted_at=NULL WHERE message_id=?").bind(messageId).run();
        }else if(action==="delete"){
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET deleted_at=unixepoch() WHERE message_id=?").bind(messageId).run();
        }else if(action==="pin"){
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET pinned=CASE WHEN pinned=1 THEN 0 ELSE 1 END WHERE message_id=?").bind(messageId).run();
        }else{
          const body=await bodyJson(request);const reaction=["❤️","😂","👍","🔥","😮","😢"].includes(body.reaction)?body.reaction:"";if(!reaction)return json(request,{error:"Unsupported reaction."},400);
          const meta=await env.AJCHAT_DB.prepare("SELECT reactions_json FROM message_meta WHERE message_id=?").bind(messageId).first();
          const reactions=parseReactions(meta?.reactions_json);const mine=reactions.findIndex(x=>Number(x.user_id)===Number(user.id)&&x.reaction===reaction);
          const next=mine>=0?reactions.filter((_,i)=>i!==mine):reactions.filter(x=>Number(x.user_id)!==Number(user.id)).concat([{user_id:Number(user.id),username:user.username,reaction}]);
          await env.AJCHAT_DB.prepare("INSERT OR REPLACE INTO message_meta(message_id,reactions_json) VALUES(?,?)").bind(messageId,JSON.stringify(next)).run();
          return json(request,{ok:true,reactions:next});
        }
        return json(request,{ok:true});
      }
      const groupMessageMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/messages$/);
      if (groupMessageMatch && (request.method === "GET" || request.method === "POST")) {
        const groupId = Number(groupMessageMatch[1]);
        const membership = await env.AJCHAT_DB
          .prepare("SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.id = ? AND gm.user_id = ?")
          .bind(groupId, user.id)
          .first();

        if (!membership) return json(request, { error: "Group not found." }, 404);

        const room = "group:" + groupId;

        if (request.method === "POST") {
          const body = await bodyJson(request);
          const messageBody = cleanMessage(body.text);
          if (!messageBody) return json(request, { error: "Message cannot be empty." }, 400);
          const replyToId = Number(body.reply_to_id || 0) || null;

          const inserted = await env.AJCHAT_DB
            .prepare("INSERT INTO messages (room_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)")
            .bind(room, user.id, user.id, messageBody)
            .run();
          const messageId = Number(inserted.meta?.last_row_id || 0);
          await env.AJCHAT_DB.prepare("INSERT INTO message_meta(message_id,reply_to_id) VALUES(?,?)").bind(messageId,replyToId).run();

          return json(request, {
            message: {
              id: messageId,
              body: messageBody,
              created_at: Math.floor(Date.now() / 1000),
              sender: user.username,
              reply_to_id: replyToId,
              reactions: []
            }
          }, 201);
        }

        const rows = await env.AJCHAT_DB.prepare(`
          SELECT m.id, m.body, m.created_at, sender.username AS sender,
                 mm.reply_to_id, mm.edited_at, mm.deleted_at, mm.pinned, mm.reactions_json
          FROM messages m
          JOIN users sender ON sender.id = m.sender_id
          LEFT JOIN message_meta mm ON mm.message_id = m.id
          WHERE m.room_id = ?
          ORDER BY m.id DESC
          LIMIT 100
        `).bind(room).all();

        return json(request, { messages: (rows.results || []).reverse().map(message => ({
          ...message,
          reactions: parseReactions(message.reactions_json),
          pinned: Boolean(Number(message.pinned || 0))
        })), group: membership });
      }

      if (url.pathname === "/api/friend-requests" && request.method === "GET") {
        const incoming = await env.AJCHAT_DB.prepare(`
          SELECT r.id, r.created_at, u.username, u.id AS user_id,
                 substr(upper(u.username), 1, 2) AS initials
          FROM friend_requests r
          JOIN users u ON u.id = r.sender_id
          WHERE r.receiver_id = ? AND r.status = 'pending'
          ORDER BY r.created_at DESC
        `).bind(user.id).all();

        const outgoing = await env.AJCHAT_DB.prepare(`
          SELECT r.id, r.created_at, u.username, u.id AS user_id,
                 substr(upper(u.username), 1, 2) AS initials
          FROM friend_requests r
          JOIN users u ON u.id = r.receiver_id
          WHERE r.sender_id = ? AND r.status = 'pending'
          ORDER BY r.created_at DESC
        `).bind(user.id).all();

        return json(request, {
          incoming: incoming.results || [],
          outgoing: outgoing.results || []
        });
      }

      const requestActionMatch = url.pathname.match(/^\/api\/friend-requests\/(\d+)\/(accept|reject)$/);
      if (requestActionMatch && request.method === "POST") {
        const requestId = Number(requestActionMatch[1]);
        const action = requestActionMatch[2];

        const friendRequest = await env.AJCHAT_DB
          .prepare("SELECT id, sender_id, receiver_id, status FROM friend_requests WHERE id = ? AND receiver_id = ? AND status = 'pending'")
          .bind(requestId, user.id)
          .first();

        if (!friendRequest) {
          return json(request, { error: "Friend request not found or already handled." }, 404);
        }

        if (action === "reject") {
          await env.AJCHAT_DB
            .prepare("UPDATE friend_requests SET status = 'rejected', updated_at = unixepoch() WHERE id = ?")
            .bind(requestId)
            .run();
          return json(request, { ok: true, status: "rejected" });
        }

        await env.AJCHAT_DB.batch([
          env.AJCHAT_DB.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = unixepoch() WHERE id = ?").bind(requestId),
          env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)").bind(user.id, friendRequest.sender_id),
          env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)").bind(friendRequest.sender_id, user.id)
        ]);
        await pushNotifyUser(env, friendRequest.sender_id, {
          title: "Friend request accepted",
          body: "@" + user.username + " accepted your friend request.",
          url: "/AJChat/",
          tag: "friend-accepted-" + requestId
        }).catch(() => {});

        const acceptedFriend = await env.AJCHAT_DB
          .prepare("SELECT id, username FROM users WHERE id = ?")
          .bind(friendRequest.sender_id)
          .first();

        return json(request, {
          ok: true,
          status: "accepted",
          friend: acceptedFriend ? { username: acceptedFriend.username, room: roomFor(user.id, acceptedFriend.id) } : null
        });
      }

      const readMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/read$/);
      if (readMatch && request.method === "POST") {
        const username = decodeURIComponent(readMatch[1]);
        const friend = await env.AJCHAT_DB
          .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
          .bind(username)
          .first();

        if (!friend || !(await isFriend(env.AJCHAT_DB, user.id, friend.id))) {
          return json(request, { error: "Friend not found." }, 404);
        }

        const room = roomFor(user.id, friend.id);
        const latest = await env.AJCHAT_DB
          .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room_id = ? AND sender_id = ? AND recipient_id = ?")
          .bind(room, friend.id, user.id)
          .first();

        const latestId = Number(latest?.id || 0);
        await env.AJCHAT_DB
          .prepare(`
            INSERT INTO friend_read_state (user_id, friend_id, last_read_message_id)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, friend_id)
            DO UPDATE SET last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
                          updated_at = unixepoch()
          `)
          .bind(user.id, friend.id, latestId)
          .run();

        return json(request, { ok: true, last_read_message_id: latestId });
      }

      const messageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageMatch && request.method === "POST") {
        const username = decodeURIComponent(messageMatch[1]);
        const friend = await env.AJCHAT_DB
          .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
          .bind(username)
          .first();

        if (!friend || !(await isFriend(env.AJCHAT_DB, user.id, friend.id))) {
          return json(request, { error: "Friend not found." }, 404);
        }

        const body = await bodyJson(request);
        const messageBody = cleanMessage(body.text);
        if (!messageBody) return json(request, { error: "Message cannot be empty." }, 400);
        const replyToId = Number(body.reply_to_id || 0) || null;

        const room = roomFor(user.id, friend.id);
        const inserted = await env.AJCHAT_DB
          .prepare("INSERT INTO messages (room_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)")
          .bind(room, user.id, friend.id, messageBody)
          .run();
        const id = Number(inserted.meta?.last_row_id || 0);
        await env.AJCHAT_DB.prepare("INSERT INTO message_meta (message_id, reply_to_id) VALUES (?, ?)").bind(id, replyToId).run();

        const message = {
          id,
          body: messageBody,
          created_at: Math.floor(Date.now() / 1000),
          sender: user.username,
          reply_to_id: replyToId,
          reactions: []
        };

        return json(request, { message }, 201);
      }

      if (messageMatch && request.method === "GET") {
        const username = decodeURIComponent(messageMatch[1]);
        const friend = await env.AJCHAT_DB
          .prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
          .bind(username)
          .first();

        if (!friend || !(await isFriend(env.AJCHAT_DB, user.id, friend.id))) {
          return json(request, { error: "Friend not found." }, 404);
        }

        const room = roomFor(user.id, friend.id);
        const rows = await env.AJCHAT_DB
          .prepare(`
            SELECT m.id, m.body, m.created_at, sender.username AS sender,
                   mm.reply_to_id, mm.edited_at, mm.deleted_at, mm.pinned, mm.reactions_json,
                   CASE
                     WHEN m.sender_id = ? AND m.id <= COALESCE((
                       SELECT last_read_message_id FROM friend_read_state
                       WHERE user_id = ? AND friend_id = ?
                     ),0) THEN 1 ELSE 0
                   END AS is_read
            FROM messages m
            JOIN users sender ON sender.id = m.sender_id
            LEFT JOIN message_meta mm ON mm.message_id = m.id
            WHERE m.room_id = ?
            ORDER BY m.id DESC
            LIMIT 100
          `)
          .bind(user.id, friend.id, user.id, room)
          .all();

        return json(request, { messages: (rows.results || []).reverse().map(message => ({
          ...message,
          reactions: parseReactions(message.reactions_json),
          pinned: Boolean(Number(message.pinned || 0)),
          is_read: Boolean(Number(message.is_read || 0))
        })) });
      }

      const profileMatch = url.pathname.match(/^\/api\/profile(?:\/([^/]+))?$/);
      if (profileMatch && (request.method === "GET" || request.method === "PUT")) {
        const username = profileMatch[1] ? decodeURIComponent(profileMatch[1]) : user.username;
        const target = await env.AJCHAT_DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
        if (!target) return json(request, { error: "User not found." }, 404);
        if (request.method === "PUT" && Number(target.id) !== Number(user.id)) return json(request, { error: "You can only edit your own profile." }, 403);
        if (request.method === "PUT") {
          const body = await bodyJson(request);
          const bio = cleanProfileText(body.bio, 160);
          const status = cleanProfileText(body.status, 80) || "Available to chat";
          const avatar = cleanProfileText(body.avatar, 8) || "✨";
          await env.AJCHAT_DB.prepare("INSERT OR REPLACE INTO profiles (user_id, bio, status, avatar, updated_at) VALUES (?, ?, ?, ?, unixepoch())").bind(user.id, bio, status, avatar).run();
        }
        const profile = await ensureProfile(env.AJCHAT_DB, target.id);
        return json(request, { username: target.username, initials: initials(target.username), profile: { bio: profile?.bio || "", status: profile?.status || "Available to chat", avatar: profile?.avatar || "✨", updated_at: Number(profile?.updated_at || 0) } });
      }


      const socialFollowMatch = url.pathname.match(/^\/api\/social\/follow\/([^/]+)$/);
      if (socialFollowMatch && request.method === "POST") {
        const username = cleanUsername(decodeURIComponent(socialFollowMatch[1]));
        const target = await env.AJCHAT_DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
        if (!target) return json(request,{error:"User not found."},404);
        if (Number(target.id) === Number(user.id)) return json(request,{error:"You cannot follow yourself."},400);
        if (await isBlocked(env.AJCHAT_DB,user.id,target.id)) return json(request,{error:"You cannot follow this user."},403);
        const existing = await env.AJCHAT_DB.prepare("SELECT 1 FROM follows WHERE follower_id=? AND following_id=?").bind(user.id,target.id).first();
        if(existing){await env.AJCHAT_DB.prepare("DELETE FROM follows WHERE follower_id=? AND following_id=?").bind(user.id,target.id).run();return json(request,{ok:true,following:false,username:target.username});}
        await env.AJCHAT_DB.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?,?)").bind(user.id,target.id).run();
        await socialNotify(env.AJCHAT_DB,{userId:target.id,actorId:user.id,type:"follow",body:"@"+user.username+" followed you."});
        await pushNotifyUser(env, target.id, {
          title: "New follower",
          body: "@" + user.username + " followed you.",
          url: "/AJChat/",
          tag: "follow-" + user.id
        }).catch(() => {});
        return json(request,{ok:true,following:true,username:target.username});
      }

      if (url.pathname === "/api/social/feed" && request.method === "GET") {
        const rows = await env.AJCHAT_DB.prepare("SELECT p.id,p.author_id,p.body,p.media_url,p.created_at,p.updated_at,u.username,COALESCE(pr.avatar,'✨') AS avatar,COALESCE(pr.status,'Available to chat') AS status,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count,(SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id) AS comment_count,EXISTS(SELECT 1 FROM post_likes l2 WHERE l2.post_id=p.id AND l2.user_id=?) AS liked,EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.post_id=p.id AND sp.user_id=?) AS saved,EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=p.author_id) AS following FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN profiles pr ON pr.user_id=p.author_id WHERE p.author_id=? OR EXISTS(SELECT 1 FROM follows f3 WHERE f3.follower_id=? AND f3.following_id=p.author_id) OR EXISTS(SELECT 1 FROM friendships fr WHERE fr.user_id=? AND fr.friend_id=p.author_id) ORDER BY p.id DESC LIMIT 50").bind(user.id,user.id,user.id,user.id,user.id,user.id).all();
        return json(request,{posts:(rows.results||[]).map(p=>({...p,id:Number(p.id),like_count:Number(p.like_count||0),comment_count:Number(p.comment_count||0),liked:Boolean(Number(p.liked)),saved:Boolean(Number(p.saved)),following:Boolean(Number(p.following))}))});
      }

      if (url.pathname === "/api/social/posts" && request.method === "POST") {
        const body=await bodyJson(request);const text=cleanProfileText(body.body,1000);const media=cleanProfileText(body.media_url,500);
        if(!text && !media)return json(request,{error:"Write something before posting."},400);
        const inserted=await env.AJCHAT_DB.prepare("INSERT INTO posts (author_id,body,media_url) VALUES (?,?,?)").bind(user.id,text,media).run();
        return json(request,{ok:true,post:{id:Number(inserted.meta?.last_row_id||0),body:text,media_url:media,username:user.username,avatar:(await ensureProfile(env.AJCHAT_DB,user.id))?.avatar||"✨"}},201);
      }

      const postControl=url.pathname.match(/^\/api\/social\/posts\/(\d+)(?:\/(like|comment|save|delete))?$/);
      if(postControl && request.method==="POST"){
        const postId=Number(postControl[1]),action=postControl[2];
        const post=await env.AJCHAT_DB.prepare("SELECT id,author_id FROM posts WHERE id=?").bind(postId).first();
        if(!post)return json(request,{error:"Post not found."},404);
        if(action==="like"){
          const liked=await env.AJCHAT_DB.prepare("SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?").bind(postId,user.id).first();
          if(liked){await env.AJCHAT_DB.prepare("DELETE FROM post_likes WHERE post_id=? AND user_id=?").bind(postId,user.id).run()}else{await env.AJCHAT_DB.prepare("INSERT INTO post_likes(post_id,user_id) VALUES(?,?)").bind(postId,user.id).run();await socialNotify(env.AJCHAT_DB,{userId:post.author_id,actorId:user.id,type:"like",postId,body:"@"+user.username+" liked your post."});}
          const count=await env.AJCHAT_DB.prepare("SELECT COUNT(*) AS count FROM post_likes WHERE post_id=?").bind(postId).first();return json(request,{ok:true,liked:!liked,like_count:Number(count?.count||0)});
        }
        if(action==="comment"){const body=await bodyJson(request);const text=cleanProfileText(body.body,500);if(!text)return json(request,{error:"Comment cannot be empty."},400);const inserted=await env.AJCHAT_DB.prepare("INSERT INTO post_comments(post_id,user_id,body) VALUES(?,?,?)").bind(postId,user.id,text).run();await socialNotify(env.AJCHAT_DB,{userId:post.author_id,actorId:user.id,type:"comment",postId,body:"@"+user.username+" commented on your post."});return json(request,{ok:true,comment:{id:Number(inserted.meta?.last_row_id||0),username:user.username,body:text,created_at:Math.floor(Date.now()/1000)}});}
        if(action==="save"){const saved=await env.AJCHAT_DB.prepare("SELECT 1 FROM saved_posts WHERE post_id=? AND user_id=?").bind(postId,user.id).first();if(saved){await env.AJCHAT_DB.prepare("DELETE FROM saved_posts WHERE post_id=? AND user_id=?").bind(postId,user.id).run()}else await env.AJCHAT_DB.prepare("INSERT INTO saved_posts(post_id,user_id) VALUES(?,?)").bind(postId,user.id).run();return json(request,{ok:true,saved:!saved});}
        if(action==="delete"){if(Number(post.author_id)!==Number(user.id))return json(request,{error:"Only the author can delete this post."},403);await env.AJCHAT_DB.prepare("DELETE FROM posts WHERE id=?").bind(postId).run();return json(request,{ok:true,deleted:true});}
      }

      const commentsMatch=url.pathname.match(/^\/api\/social\/posts\/(\d+)\/comments$/);
      if(commentsMatch && request.method==="GET"){const postId=Number(commentsMatch[1]);const rows=await env.AJCHAT_DB.prepare("SELECT c.id,c.body,c.created_at,u.username,COALESCE(p.avatar,'✨') AS avatar FROM post_comments c JOIN users u ON u.id=c.user_id LEFT JOIN profiles p ON p.user_id=u.id WHERE c.post_id=? ORDER BY c.id ASC LIMIT 100").bind(postId).all();return json(request,{comments:rows.results||[]});}

      if (url.pathname === "/api/social/explore" && request.method === "GET") {
        const q=cleanProfileText(url.searchParams.get("q"),60);const like="%"+q+"%";
        const people=await env.AJCHAT_DB.prepare("SELECT u.id,u.username,COALESCE(p.avatar,'✨') AS avatar,COALESCE(p.bio,'') AS bio,EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=u.id) AS following,CASE WHEN EXISTS(SELECT 1 FROM friendships fr WHERE fr.user_id=? AND fr.friend_id=u.id) THEN 'friends' WHEN EXISTS(SELECT 1 FROM friend_requests frq WHERE frq.sender_id=? AND frq.receiver_id=u.id AND frq.status='pending') THEN 'pending' WHEN EXISTS(SELECT 1 FROM friend_requests frq WHERE frq.sender_id=u.id AND frq.receiver_id=? AND frq.status='pending') THEN 'incoming' ELSE 'none' END AS friend_status FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id<>? AND (?='' OR u.username LIKE ? COLLATE NOCASE) ORDER BY u.username COLLATE NOCASE LIMIT 30").bind(user.id,user.id,user.id,user.id,user.id,q,like).all();
        const posts=await env.AJCHAT_DB.prepare("SELECT p.id,p.body,p.media_url,p.created_at,u.username,COALESCE(pr.avatar,'✨') AS avatar,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN profiles pr ON pr.user_id=p.author_id WHERE ?='' OR p.body LIKE ? COLLATE NOCASE ORDER BY p.id DESC LIMIT 30").bind(q,like).all();
        return json(request,{people:(people.results||[]).map(x=>({...x,following:Boolean(Number(x.following))})),posts:(posts.results||[]).map(x=>({...x,id:Number(x.id),like_count:Number(x.like_count||0)}))});
      }

      if(url.pathname==="/api/social/stories" && request.method==="GET"){
        const rows=await env.AJCHAT_DB.prepare("SELECT s.id,s.user_id,s.body,s.media_url,s.created_at,s.expires_at,u.username,COALESCE(p.avatar,'✨') AS avatar,EXISTS(SELECT 1 FROM story_views v WHERE v.story_id=s.id AND v.user_id=?) AS viewed FROM stories s JOIN users u ON u.id=s.user_id LEFT JOIN profiles p ON p.user_id=u.id WHERE s.expires_at>unixepoch() AND (s.user_id=? OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=? AND f.following_id=s.user_id) OR EXISTS(SELECT 1 FROM friendships fr WHERE fr.user_id=? AND fr.friend_id=s.user_id)) ORDER BY s.id DESC LIMIT 100").bind(user.id,user.id,user.id,user.id).all();
        return json(request,{stories:(rows.results||[]).map(x=>({...x,id:Number(x.id),viewed:Boolean(Number(x.viewed))}))});
      }

      if(url.pathname==="/api/social/stories" && request.method==="POST"){const body=await bodyJson(request);const text=cleanProfileText(body.body,240);if(!text)return json(request,{error:"Story cannot be empty."},400);const inserted=await env.AJCHAT_DB.prepare("INSERT INTO stories(user_id,body,media_url,expires_at) VALUES(?,?,?,unixepoch()+86400)").bind(user.id,text,cleanProfileText(body.media_url,500)).run();return json(request,{ok:true,id:Number(inserted.meta?.last_row_id||0)},201);}

      const storyView=url.pathname.match(/^\/api\/social\/stories\/(\d+)\/view$/);
      if(storyView && request.method==="POST"){const storyId=Number(storyView[1]);const story=await env.AJCHAT_DB.prepare("SELECT id,user_id FROM stories WHERE id=? AND expires_at>unixepoch()").bind(storyId).first();if(!story)return json(request,{error:"Story not found."},404);await env.AJCHAT_DB.prepare("INSERT OR REPLACE INTO story_views(story_id,user_id,viewed_at) VALUES(?,?,unixepoch())").bind(storyId,user.id).run();return json(request,{ok:true});}

      const socialProfile=url.pathname.match(/^\/api\/social\/profile\/([^/]+)$/);
      if(socialProfile && request.method==="GET"){
        const username=decodeURIComponent(socialProfile[1]);const target=await env.AJCHAT_DB.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").bind(username).first();if(!target)return json(request,{error:"User not found."},404);
        const profile=await ensureProfile(env.AJCHAT_DB,target.id);
        const [posts,counts,follow,friendStatus] = await Promise.all([env.AJCHAT_DB.prepare("SELECT p.id,p.body,p.media_url,p.created_at,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count,(SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id) AS comment_count,EXISTS(SELECT 1 FROM post_likes l2 WHERE l2.post_id=p.id AND l2.user_id=?) AS liked FROM posts p WHERE p.author_id=? ORDER BY p.id DESC LIMIT 50").bind(user.id,target.id).all(),env.AJCHAT_DB.prepare("SELECT (SELECT COUNT(*) FROM follows WHERE following_id=?) AS followers,(SELECT COUNT(*) FROM follows WHERE follower_id=?) AS following,(SELECT COUNT(*) FROM posts WHERE author_id=?) AS posts").bind(target.id,target.id,target.id).first(),env.AJCHAT_DB.prepare("SELECT 1 FROM follows WHERE follower_id=? AND following_id=?").bind(user.id,target.id).first(),env.AJCHAT_DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM friendships WHERE user_id=? AND friend_id=?) THEN 'friends' WHEN EXISTS(SELECT 1 FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending') THEN 'pending' WHEN EXISTS(SELECT 1 FROM friend_requests WHERE sender_id=? AND receiver_id=? AND status='pending') THEN 'incoming' ELSE 'none' END AS status").bind(user.id,target.id,user.id,target.id,target.id,user.id).first()]);
        return json(request,{username:target.username,initials:initials(target.username),profile:{bio:profile?.bio||"",status:profile?.status||"Available to chat",avatar:profile?.avatar||"✨"},stats:{followers:Number(counts?.followers||0),following:Number(counts?.following||0),posts:Number(counts?.posts||0)},following:Boolean(follow),friend_status:String(friendStatus?.status||"none"),self:Number(target.id)===Number(user.id),posts:(posts.results||[]).map(x=>({...x,id:Number(x.id),like_count:Number(x.like_count||0),comment_count:Number(x.comment_count||0),liked:Boolean(Number(x.liked))}))});
      }

      if(url.pathname==="/api/social/saved" && request.method==="GET"){
        const rows=await env.AJCHAT_DB.prepare("SELECT p.id,p.body,p.media_url,p.created_at,u.username,COALESCE(pr.avatar,'✨') AS avatar,(SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count,(SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id) AS comment_count FROM saved_posts sp JOIN posts p ON p.id=sp.post_id JOIN users u ON u.id=p.author_id LEFT JOIN profiles pr ON pr.user_id=p.author_id WHERE sp.user_id=? ORDER BY sp.created_at DESC LIMIT 50").bind(user.id).all();
        return json(request,{posts:(rows.results||[]).map(x=>({...x,id:Number(x.id),like_count:Number(x.like_count||0),comment_count:Number(x.comment_count||0),saved:true}))});
      }

      if(url.pathname==="/api/social/notifications" && request.method==="GET"){const rows=await env.AJCHAT_DB.prepare("SELECT n.id,n.type,n.body,n.created_at,n.read_at,u.username,COALESCE(p.avatar,'✨') AS avatar,n.post_id FROM notifications n LEFT JOIN users u ON u.id=n.actor_id LEFT JOIN profiles p ON p.user_id=n.actor_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 50").bind(user.id).all();return json(request,{notifications:rows.results||[]});}
      if(url.pathname==="/api/social/notifications/read" && request.method==="POST"){await env.AJCHAT_DB.prepare("UPDATE notifications SET read_at=unixepoch() WHERE user_id=? AND read_at IS NULL").bind(user.id).run();return json(request,{ok:true});}

      if (url.pathname === "/api/social/global/messages" && request.method === "GET") {
        const rows=await env.AJCHAT_DB.prepare("SELECT gm.id,gm.body,gm.created_at,u.username,COALESCE(p.avatar,'✨') AS avatar FROM global_messages gm JOIN users u ON u.id=gm.sender_id LEFT JOIN profiles p ON p.user_id=gm.sender_id ORDER BY gm.id DESC LIMIT 100").all();
        return json(request,{messages:(rows.results||[]).reverse()});
      }

      if (url.pathname === "/api/social/global/messages" && request.method === "POST") {
        const body=await bodyJson(request);
        const text=cleanProfileText(body.body,500);
        if(!text)return json(request,{error:"Message cannot be empty."},400);
        const inserted=await env.AJCHAT_DB.prepare("INSERT INTO global_messages(sender_id,body) VALUES(?,?)").bind(user.id,text).run();
        const id=Number(inserted.meta?.last_row_id||0),createdAt=Math.floor(Date.now()/1000);
        return json(request,{ok:true,message:{id,body:text,created_at:createdAt,username:user.username,avatar:(await ensureProfile(env.AJCHAT_DB,user.id))?.avatar||'✨'}},201);
      }

      if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
        const body = await bodyJson(request);
        const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
        const newPassword = typeof body.new_password === "string" ? body.new_password : "";
        const record = await env.AJCHAT_DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(user.id).first();
        if (!record || !(await verifyPassword(currentPassword, record.password_hash))) return json(request,{error:"Current password is incorrect."},401);
        if (newPassword.length < 8) return json(request,{error:"New password must be at least 8 characters."},400);
        const passwordHash = await hashPassword(newPassword);
        await env.AJCHAT_DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(passwordHash,user.id).run();
        return json(request,{ok:true});
      }

      if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
        await env.AJCHAT_DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id).run();
        return json(request,{ok:true});
      }

      const friendControlMatch = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
      if (friendControlMatch && request.method === "DELETE") {
        const username = decodeURIComponent(friendControlMatch[1]);
        const friend = await env.AJCHAT_DB.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
        if (!friend || !(await isFriend(env.AJCHAT_DB,user.id,friend.id))) return json(request,{error:"Friend not found."},404);
        await env.AJCHAT_DB.batch([
          env.AJCHAT_DB.prepare("DELETE FROM friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)").bind(user.id,friend.id,friend.id,user.id),
          env.AJCHAT_DB.prepare("DELETE FROM friend_requests WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?)").bind(user.id,friend.id,friend.id,user.id)
        ]);
        return json(request,{ok:true,removed:friend.username});
      }

      if (url.pathname === "/api/blocks" && request.method === "GET") {
        const rows = await env.AJCHAT_DB.prepare("SELECT u.id, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY u.username COLLATE NOCASE").bind(user.id).all();
        return json(request, { blocks: rows.results || [] });
      }

      if (url.pathname === "/api/blocks" && request.method === "POST") {
        const body = await bodyJson(request);
        const username = cleanUsername(body.username);
        const target = await env.AJCHAT_DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
        if (!target) return json(request, { error: "User not found." }, 404);
        if (Number(target.id) === Number(user.id)) return json(request, { error: "You cannot block yourself." }, 400);
        await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)").bind(user.id, target.id).run();
        return json(request, { ok: true, username: target.username });
      }

      const blockMatch = url.pathname.match(/^\/api\/blocks\/([^/]+)$/);
      if (blockMatch && request.method === "DELETE") {
        const target = await env.AJCHAT_DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").bind(decodeURIComponent(blockMatch[1])).first();
        if (!target) return json(request, { error: "User not found." }, 404);
        await env.AJCHAT_DB.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(user.id, target.id).run();
        return json(request, { ok: true });
      }
      const messageControl = url.pathname.match(/^\/api\/messages\/([^/]+)\/(\d+)\/(edit|delete|react|pin)$/);
      if (messageControl && request.method === "POST") {
        const username = decodeURIComponent(messageControl[1]);
        const messageId = Number(messageControl[2]);
        const action = messageControl[3];
        const friend = await env.AJCHAT_DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
        if (!friend || !(await isFriend(env.AJCHAT_DB, user.id, friend.id))) return json(request,{error:"Friend not found."},404);
        const message = await env.AJCHAT_DB.prepare("SELECT id,sender_id FROM messages WHERE id=? AND room_id=?").bind(messageId,roomFor(user.id,friend.id)).first();
        if (!message) return json(request,{error:"Message not found."},404);
        if (action !== "react" && Number(message.sender_id)!==Number(user.id)) return json(request,{error:"Only the sender can change this message."},403);
        if (action==="edit") {
          const body=await bodyJson(request); const next=cleanMessage(body.text);
          if(!next)return json(request,{error:"Message cannot be empty."},400);
          await env.AJCHAT_DB.prepare("UPDATE messages SET body=? WHERE id=?").bind(next,messageId).run();
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET edited_at=unixepoch(),deleted_at=NULL WHERE message_id=?").bind(messageId).run();
        } else if (action==="delete") {
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET deleted_at=unixepoch() WHERE message_id=?").bind(messageId).run();
        } else if (action==="pin") {
          await env.AJCHAT_DB.prepare("INSERT OR IGNORE INTO message_meta(message_id) VALUES(?)").bind(messageId).run();
          await env.AJCHAT_DB.prepare("UPDATE message_meta SET pinned=CASE WHEN pinned=1 THEN 0 ELSE 1 END WHERE message_id=?").bind(messageId).run();
        } else {
          const body=await bodyJson(request);
          const reaction=["❤️","😂","👍","🔥","😮","😢"].includes(body.reaction)?body.reaction:"";
          if(!reaction)return json(request,{error:"Unsupported reaction."},400);
          const meta=await env.AJCHAT_DB.prepare("SELECT reactions_json FROM message_meta WHERE message_id=?").bind(messageId).first();
          const reactions=parseReactions(meta?.reactions_json);
          const mine=reactions.findIndex(item=>Number(item.user_id)===Number(user.id)&&item.reaction===reaction);
          const next=mine>=0?reactions.filter((_,i)=>i!==mine):reactions.filter(item=>Number(item.user_id)!==Number(user.id)).concat([{user_id:Number(user.id),username:user.username,reaction}]);
          await env.AJCHAT_DB.prepare("INSERT OR REPLACE INTO message_meta(message_id,reactions_json) VALUES(?,?)").bind(messageId,JSON.stringify(next)).run();
          return json(request,{ok:true,reactions:next});
        }
        return json(request,{ok:true});
      }


      const messageSearch = url.pathname.match(/^\/api\/messages\/([^/]+)\/search$/);
      if (messageSearch && request.method === "GET") {
        const username=decodeURIComponent(messageSearch[1]);
        const friend=await env.AJCHAT_DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
        if(!friend || !(await isFriend(env.AJCHAT_DB,user.id,friend.id))) return json(request,{error:"Friend not found."},404);
        const q=cleanProfileText(url.searchParams.get("q"),120);
        if(!q)return json(request,{messages:[]});
        const rows=await env.AJCHAT_DB.prepare("SELECT m.id,m.body,m.created_at,sender.username AS sender,mm.reply_to_id,mm.edited_at,mm.deleted_at,mm.pinned,mm.reactions_json FROM messages m JOIN users sender ON sender.id=m.sender_id LEFT JOIN message_meta mm ON mm.message_id=m.id WHERE m.room_id=? AND m.body LIKE ? COLLATE NOCASE ORDER BY m.id DESC LIMIT 50").bind(roomFor(user.id,friend.id),"%"+q+"%").all();
        return json(request,{messages:(rows.results||[]).reverse().map(m=>({...m,reactions:parseReactions(m.reactions_json),pinned:Boolean(Number(m.pinned||0))}))});
      }
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const header = request.headers.get("Authorization") || "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (token) await env.AJCHAT_DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
        return json(request, { ok: true });
      }

      return json(request, { error: "Not found" }, 404);
    } catch (error) {
      return json(request, { error: error?.message || "Server error" }, 500);
    }
  }
};

async function pushNotifyUser(env, userId, payload) {
  const publicKey = typeof env.VAPID_PUBLIC_KEY === "string" ? env.VAPID_PUBLIC_KEY.trim() : "";
  const privateKey = typeof env.VAPID_PRIVATE_KEY === "string" ? env.VAPID_PRIVATE_KEY.trim() : "";
  if (!publicKey || !privateKey) return;

  const rows = await env.AJCHAT_DB
    .prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?")
    .bind(userId)
    .all();

  const vapid = {
    subject: typeof env.VAPID_SUBJECT === "string" && env.VAPID_SUBJECT.trim()
      ? env.VAPID_SUBJECT.trim()
      : "https://aj-8a.github.io/AJChat/",
    publicKey,
    privateKey
  };

  await Promise.all((rows.results || []).map(async subscription => {
    const target = {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth }
    };
    try {
      const delivered = await sendPushNotification(target, payload, vapid);
      if (delivered === false) {
        await env.AJCHAT_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(subscription.endpoint).run();
      }
    } catch (error) {
      const status = Number(error?.statusCode || 0);
      if (status === 404 || status === 410) {
        await env.AJCHAT_DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(subscription.endpoint).run();
      }
    }
  }));
}

async function pushNotifyFriendsOnline(env, userId, username) {
  const rows = await env.AJCHAT_DB
    .prepare("SELECT CASE WHEN user_id=? THEN friend_id ELSE user_id END AS friend_id FROM friendships WHERE user_id=? OR friend_id=?")
    .bind(userId, userId, userId)
    .all();

  await Promise.all((rows.results || []).map(row =>
    pushNotifyUser(env, Number(row.friend_id), {
      title: "AJChat",
      body: "@" + username + " is online now.",
      url: "/AJChat/",
      tag: "online-" + userId
    }).catch(() => {})
  ));
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.lastMessageAt = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const userId = Number(request.headers.get("x-ajchat-user-id"));
    const username = request.headers.get("x-ajchat-username") || "";
    const room = new URL(request.url).searchParams.get("room") || "";
    if (!userId || !username || !room) return new Response("Unauthorized", { status: 401 });

    if (room !== "global" && room !== "calls") {
      const pair = room.split(":").slice(1).map(Number);
      if (pair.length !== 2 || !pair.includes(userId)) return new Response("Forbidden", { status: 403 });
    }

    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];

    this.ctx.acceptWebSocket(server, [String(userId)]);
    server.serializeAttachment({ userId, username, room });

    const online = this.ctx.getWebSockets().some(ws => {
      const attachment = ws.deserializeAttachment();
      return attachment && Number(attachment.userId) !== userId;
    });

    server.send(JSON.stringify({ type: "ready", room, online }));

    if (room === "global") {
      try {
        const rows = await this.env.AJCHAT_DB
          .prepare("SELECT gm.id, gm.body, gm.created_at, u.username, COALESCE(p.avatar,'✨') AS avatar FROM global_messages gm JOIN users u ON u.id=gm.sender_id LEFT JOIN profiles p ON p.user_id=gm.sender_id ORDER BY gm.id DESC LIMIT 100")
          .all();
        const messages = (rows.results || []).reverse();
        server.send(JSON.stringify({ type: "history", messages }));
      } catch {}
    }

    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "presence", online: true }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    if (!attachment) return;

    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data?.type === "typing") {
      const typingPayload = JSON.stringify({
        type: "typing",
        username: attachment.username,
        typing: Boolean(data.typing)
      });
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== ws && socket.readyState === WebSocket.OPEN) socket.send(typingPayload);
      }
      return;
    }

    if (["call-invite","call-accept","call-offer","call-answer","call-ice","call-end","call-reject"].includes(data?.type)) {
      const targetId = Number(data.to_user_id || 0);
      const relay = {
        type: data.type,
        username: attachment.username,
        from_user_id: Number(attachment.userId)
      };
      if (data.mode) relay.mode = data.mode;
      if (data.sdp) relay.sdp = data.sdp;
      if (data.candidate) relay.candidate = data.candidate;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket === ws || socket.readyState !== WebSocket.OPEN) continue;
        const other = socket.deserializeAttachment();
        if (!other || Number(other.userId) !== targetId) continue;
        socket.send(JSON.stringify(relay));
      }
      return;
    }

    if (data?.type !== "message") return;

    const body = cleanMessage(data.text);
    if (!body) return;

    const now = Date.now();
    const previous = Number(this.lastMessageAt.get(Number(attachment.userId)) || 0);
    if (now - previous < 550) {
      try { ws.send(JSON.stringify({ type: "rate_limited", message: "Slow down a little." })); } catch {}
      return;
    }
    this.lastMessageAt.set(Number(attachment.userId), now);

    let payload;
    if (attachment.room === "global") {
      const inserted = await this.env.AJCHAT_DB
        .prepare("INSERT INTO global_messages (sender_id, body) VALUES (?, ?)")
        .bind(attachment.userId, body)
        .run();
      const id = Number(inserted.meta?.last_row_id || 0);
      const createdAt = Math.floor(now / 1000);
      payload = JSON.stringify({
        type: "message",
        message: { id, body, username: attachment.username, sender: attachment.username, created_at: createdAt }
      });
    } else {
      const [a, b] = attachment.room.split(":").slice(1).map(Number);
      const recipientId = a === Number(attachment.userId) ? b : a;
      const inserted = await this.env.AJCHAT_DB
        .prepare("INSERT INTO messages (room_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)")
        .bind(attachment.room, attachment.userId, recipientId, body)
        .run();
      const id = Number(inserted.meta?.last_row_id || 0);
      const createdAt = Math.floor(now / 1000);
      payload = JSON.stringify({
        type: "message",
        message: { id, body, sender: attachment.username, username: attachment.username, created_at: createdAt }
      });
    }

    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }

    if (attachment.room !== "global") {
      const [a, b] = attachment.room.split(":").slice(1).map(Number);
      const recipientId = a === Number(attachment.userId) ? b : a;
      if (recipientId && recipientId !== Number(attachment.userId)) {
        this.ctx.waitUntil(pushNotifyUser(this.env, recipientId, {
          title: "@" + attachment.username,
          body,
          url: "/AJChat/",
          tag: "chat-" + attachment.room
        }).catch(() => {}));
      }
    }
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment) return;

    const stillOnline = this.ctx.getWebSockets().some(other => {
      if (other === ws) return false;
      const item = other.deserializeAttachment();
      return item && Number(item.userId) === Number(attachment.userId);
    });

    if (!stillOnline) {
      for (const socket of this.ctx.getWebSockets()) {
        if (socket !== ws && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "presence", online: false }));
        }
      }
    }
  }
}
