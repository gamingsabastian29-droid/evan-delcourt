from pathlib import Path
p=Path('/mnt/data/evan_work2/server.js'); s=p.read_text()
s=s.replace('function createSession(req, userId){ const id=crypto.randomUUID(); db.prepare("INSERT INTO user_sessions(id,user_id,user_agent,ip) VALUES(?,?,?,?)").run(id,userId,String(req.headers["user-agent"]||"").slice(0,500),clientIp(req)); req.session.sessionId=id; req.session.sessionVersion=1; return id; }', 'function createSession(req, userId){ const id=crypto.randomUUID(); const row=db.prepare("SELECT session_version FROM users WHERE id=?").get(userId); db.prepare("INSERT INTO user_sessions(id,user_id,user_agent,ip) VALUES(?,?,?,?)").run(id,userId,String(req.headers["user-agent"]||"").slice(0,500),clientIp(req)); req.session.sessionId=id; req.session.sessionVersion=row?.session_version || 1; return id; }')
# Add isAdmin marker and visitors route before overview
needle="app.get('/api/admin/overview'"
insert="""app.get('/api/admin/visitors',(req,res)=>{ const u=currentUser(req); if(!isAdmin(u)) return res.status(403).json({error:'Accès administrateur uniquement.'}); const total=db.prepare('SELECT COUNT(*) c FROM visitor_logs').get().c; const today=db.prepare(\"SELECT COUNT(*) c FROM visitor_logs WHERE date(created_at)=date('now')\").get().c; const uniqueToday=db.prepare(\"SELECT COUNT(DISTINCT ip) c FROM visitor_logs WHERE date(created_at)=date('now')\").get().c; const visitors=db.prepare(\"SELECT id,ip,path,method,user_id,user_agent,referer,created_at FROM visitor_logs ORDER BY id DESC LIMIT 200\").all(); res.json({total,today,uniqueToday,visitors}); });\napp.delete('/api/admin/visitors',(req,res)=>{ const u=currentUser(req); if(!isAdmin(u)) return res.status(403).json({error:'Accès administrateur uniquement.'}); db.prepare('DELETE FROM visitor_logs').run(); res.json({ok:true}); });\n\n"""+needle
s=s.replace(needle,insert)
# admin overview users isAdmin
s=s.replace("const users=db.prepare(\"SELECT id,display_name,email,subscription_status,created_at FROM users ORDER BY id DESC LIMIT 200\").all();", "const users=db.prepare(\"SELECT id,display_name,email,subscription_status,created_at FROM users ORDER BY id DESC LIMIT 200\").all().map(x=>({...x,isAdmin:isAdmin(x)}));")
p.write_text(s)

p=Path('/mnt/data/evan_work2/vip.html'); s=p.read_text()
s=s.replace("${u.id!==d.users.find(x=>x.email===document.getElementById('loginEmail')?.value)?.id?`<button class=\"danger small\" onclick=\"deleteAdminUser(${u.id})\">Supprimer</button>`:''}", "${!u.isAdmin?`<button class=\"danger small\" onclick=\"deleteAdminUser(${u.id})\">Supprimer</button>`:''}")
p.write_text(s)
