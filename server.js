import express from "express";
import Stripe from "stripe";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
import crypto from "crypto";
import nodemailer from "nodemailer";

dotenv.config();

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn("SESSION_SECRET manquant ou trop court. Utilise une valeur d’au moins 32 caractères en production.");
}

const app = express();
// Render terminates HTTPS at its proxy. Trust the proxy so secure session cookies are set correctly.
app.set("trust proxy", 1);
const port = process.env.PORT || 3000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const db = new Database("members.db");

db.exec(`
CREATE TABLE IF NOT EXISTS free_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Fan',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Fan',
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  cancel_at_period_end INTEGER DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,title), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'Écouté', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,name), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(playlist_id,title), FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, message TEXT NOT NULL, vip_only INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS likes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, content_type TEXT NOT NULL, content_title TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,content_type,content_title), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, content_type TEXT NOT NULL, content_title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS comment_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS comment_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT 'Autre', created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(comment_id,user_id), FOREIGN KEY(comment_id) REFERENCES comments(id) ON DELETE CASCADE, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER PRIMARY KEY, theme TEXT NOT NULL DEFAULT 'system', notifications INTEGER NOT NULL DEFAULT 1, compact_mode INTEGER NOT NULL DEFAULT 0, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS badges (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, badge_key TEXT NOT NULL, badge_name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,badge_key), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS project_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id,name), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, email TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS visitor_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL, user_id INTEGER, user_agent TEXT DEFAULT '', referer TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, read_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, user_agent TEXT DEFAULT '', ip TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS email_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL, new_password_hash TEXT, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
`);

// Migration for existing installations created before the Premium ranking.
try {
  db.prepare("ALTER TABLE free_subscribers ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Fan'").run();
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
try {
  db.prepare("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Fan'").run();
} catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}
try { db.prepare("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1").run(); } catch (e) { if (!String(e.message).includes("duplicate column name")) throw e; }
for (const col of [
  ['bio',"TEXT NOT NULL DEFAULT ''"],
  ['profile_photo',"TEXT NOT NULL DEFAULT ''"]
]) { try { db.prepare(`ALTER TABLE users ADD COLUMN ${col[0]} ${col[1]}`).run(); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; } }
for (const col of [
  ['security_enabled','INTEGER NOT NULL DEFAULT 1'],
  ['link_protection','INTEGER NOT NULL DEFAULT 1'],
  ['spam_protection','INTEGER NOT NULL DEFAULT 1']
]) { try { db.prepare(`ALTER TABLE user_settings ADD COLUMN ${col[0]} ${col[1]}`).run(); } catch (e) { if (!String(e.message).includes('duplicate column name')) throw e; } }

app.set("trust proxy", 1);

// Autorise un frontend séparé (ex. GitHub Pages) si FRONTEND_URL est défini.
app.use((req, res, next) => {
  const origin = process.env.FRONTEND_URL;
  if (origin && req.headers.origin === origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const sessionSecret = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
  ? process.env.SESSION_SECRET
  : "dev-only-change-this-session-secret-please-123456789";

app.use(cookieSession({
  name: "evan_session",
  keys: [sessionSecret],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 1000 * 60 * 60 * 24 * 7
}));

// Stripe webhook must receive the raw body BEFORE express.json().
app.post("/api/stripe/webhook", express.raw({type: "application/json"}), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send("Stripe webhook non configuré.");
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const updateByCustomer = (customerId, status, subscriptionId = null, cancelAtPeriodEnd = null) => {
    db.prepare(`
      UPDATE users
      SET subscription_status=?, subscription_id=COALESCE(?, subscription_id),
          cancel_at_period_end=COALESCE(?, cancel_at_period_end)
      WHERE stripe_customer_id=?
    `).run(status, subscriptionId, cancelAtPeriodEnd === null ? null : (cancelAtPeriodEnd ? 1 : 0), customerId);
  };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode === "subscription" && session.customer) {
      updateByCustomer(session.customer, "active", session.subscription, false);
    }
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    updateByCustomer(sub.customer, sub.status, sub.id, sub.cancel_at_period_end);
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    updateByCustomer(sub.customer, "canceled", sub.id, false);
  }

  res.json({received: true});
});

app.use(express.json({ limit: "100kb" }));

const mailTransport = (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    }) : null;
const siteEmail = String(process.env.SITE_EMAIL || process.env.SMTP_USER || '').trim();
function verificationHash(code){ return crypto.createHash('sha256').update(String(code) + sessionSecret).digest('hex'); }
function newVerificationCode(){ return String(crypto.randomInt(100000,1000000)); }
function isoSql(date){ return date.toISOString().replace('T',' ').replace('Z','').slice(0,19); }
async function sendVerificationCode(user,purpose,code){
  if(!mailTransport || !siteEmail) throw new Error('Le service courriel n’est pas configuré sur le serveur.');
  const login=purpose==='login';
  const subject=login?'Code de connexion — Evan_Delcourt':'Code de sécurité — changement de mot de passe';
  const intro=login?'Voici ton code pour terminer la connexion à ton compte Evan_Delcourt.':'Voici ton code pour confirmer le changement de mot de passe de ton compte Evan_Delcourt.';
  await mailTransport.sendMail({from:`Evan_Delcourt <${siteEmail}>`,to:user.email,subject,text:`${intro}\n\nCode : ${code}\n\nCe code expire dans 10 minutes. Si tu n’es pas à l’origine de cette demande, ignore ce courriel.`,html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;background:#11152b;color:#f7f7ff;border-radius:18px"><h2>🔐 Evan_Delcourt</h2><p>${intro}</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:20px;background:#090b18;border-radius:14px">${code}</div><p>Ce code expire dans <b>10 minutes</b>.</p><p style="color:#a7acc7">Si tu n’as pas demandé ce code, ignore ce message.</p></div>`});
}
async function createVerification(userId,purpose,newPasswordHash=null){
  const user=db.prepare('SELECT id,email,display_name FROM users WHERE id=?').get(userId); if(!user) throw new Error('Compte introuvable.');
  const recent=db.prepare('SELECT created_at FROM email_verifications WHERE user_id=? AND purpose=? ORDER BY id DESC LIMIT 1').get(userId,purpose);
  if(recent){const t=new Date(String(recent.created_at).replace(' ','T')+'Z').getTime();if(Date.now()-t<60000)throw new Error('Attends 60 secondes avant de demander un nouveau code.');}
  const code=newVerificationCode(); db.prepare('UPDATE email_verifications SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND purpose=? AND used_at IS NULL').run(userId,purpose);
  const expires=isoSql(new Date(Date.now()+10*60000)); const r=db.prepare('INSERT INTO email_verifications(user_id,purpose,code_hash,new_password_hash,expires_at) VALUES(?,?,?,?,?)').run(userId,purpose,verificationHash(code),newPasswordHash,expires);
  try{await sendVerificationCode(user,purpose,code);}catch(e){db.prepare('DELETE FROM email_verifications WHERE id=?').run(r.lastInsertRowid);throw e;} return r.lastInsertRowid;
}

app.get("/health", (req, res) => res.json({ ok: true, service: "evan-delcourt" }));
function createSession(req, userId){ const id=crypto.randomUUID(); const row=db.prepare("SELECT session_version FROM users WHERE id=?").get(userId); db.prepare("INSERT INTO user_sessions(id,user_id,user_agent,ip) VALUES(?,?,?,?)").run(id,userId,String(req.headers["user-agent"]||"").slice(0,500),clientIp(req)); req.session.sessionId=id; req.session.sessionVersion=row?.session_version || 1; return id; }
function touchSession(req){ if(req.session?.sessionId){ try{ db.prepare("UPDATE user_sessions SET last_seen=CURRENT_TIMESTAMP,ip=?,user_agent=? WHERE id=? AND user_id=?").run(clientIp(req),String(req.headers["user-agent"]||"").slice(0,500),req.session.sessionId,req.session.userId); }catch{} } }
function isAdmin(user) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!user && !!adminEmail && String(user.email).toLowerCase() === adminEmail;
}

// Journalise les visites anonymes et connectées. Seuls les chemins de pages sont conservés,
// pas le contenu des formulaires. L'accès aux journaux est réservé à l'administrateur.
app.use((req, res, next) => {
  const path = String(req.path || '/');
  const isPage = req.method === 'GET' && (path === '/' || path.endsWith('.html') || path === '/health');
  if (isPage) {
    try {
      const uid = req.session?.userId ? Number(req.session.userId) : null;
      db.prepare('INSERT INTO visitor_logs(ip,path,method,user_id,user_agent,referer) VALUES(?,?,?,?,?,?)')
        .run(clientIp(req), path.slice(0,300), req.method, uid || null, String(req.headers['user-agent'] || '').slice(0,500), String(req.headers.referer || '').slice(0,500));
    } catch {}
  }
  next();
});

app.use(express.static("public"));

function currentUser(req) {
  if (!req.session?.userId) return null;
  const user = db.prepare("SELECT id,email,display_name,subscription_status,cancel_at_period_end,created_at,session_version FROM users WHERE id=?").get(req.session.userId);
  if (!user) return null;
  if (req.session.sessionVersion && Number(req.session.sessionVersion) !== Number(user.session_version)) return null;
  if (!req.session.sessionId) return null;
  const sess=db.prepare("SELECT id FROM user_sessions WHERE id=? AND user_id=?").get(req.session.sessionId,user.id);
  if (!sess) return null;
  touchSession(req);
  return user;
}

// Accès membre : toutes les fonctions du site/API restent verrouillées tant que la personne n'est pas connectée.
// Exceptions : inscription, connexion, déconnexion, état de session, abonnement FREE initial et webhook Stripe.
app.use('/api', (req,res,next) => {
  const open = new Set(['/me','/register','/access','/login','/login/verify','/login/resend-code','/logout','/free-subscribe','/stripe/webhook','/announcements']);
  if (open.has(req.path)) return next();
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:'Accès verrouillé. Connecte-toi ou crée un compte pour continuer.'});
  req.authUser = user;
  next();
});

// Compteur de visiteurs privé : accessible uniquement à l'administrateur.
app.get('/api/admin/visitors', (req,res) => {
  if (!isAdmin(req.authUser)) return res.status(403).json({error:'Accès administrateur requis.'});
  const total = db.prepare("SELECT COUNT(*) c FROM visitor_logs WHERE path <> '/health'").get().c;
  const today = db.prepare("SELECT COUNT(*) c FROM visitor_logs WHERE path <> '/health' AND date(created_at)=date('now')").get().c;
  const uniqueToday = db.prepare("SELECT COUNT(DISTINCT ip) c FROM visitor_logs WHERE path <> '/health' AND date(created_at)=date('now')").get().c;
  const visitors = db.prepare("SELECT ip,path,user_id,user_agent,referer,created_at FROM visitor_logs WHERE path <> '/health' ORDER BY id DESC LIMIT 100").all();
  res.json({total,today,uniqueToday,visitors});
});
app.delete('/api/admin/visitors', (req,res) => {
  if (!isAdmin(req.authUser)) return res.status(403).json({error:'Accès administrateur requis.'});
  db.prepare("DELETE FROM visitor_logs").run();
  res.json({ok:true});
});

app.post("/api/free-subscribe", async (req,res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim().slice(0,40);
  const password = String(req.body.password || "");
  if (!email || !email.includes("@") || !displayName || password.length < 8)
    return res.status(400).json({error:"Nom, courriel ou mot de passe invalide (8 caractères minimum)."});
  try {
    const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    if (existing) return res.status(409).json({error:"Ce courriel existe déjà. Connecte-toi avec ton mot de passe."});
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users(email,display_name,password_hash,subscription_status) VALUES(?,?,?,?)").run(email, displayName, hash, "inactive");
    req.session.userId = result.lastInsertRowid; createSession(req, result.lastInsertRowid);
    // Keep the legacy free-subscriber table in sync for existing ranking data.
    db.prepare("INSERT OR IGNORE INTO free_subscribers(email,display_name) VALUES(?,?)").run(email, displayName);
    res.json({ok:true});
  } catch (e) {
    res.status(500).json({error:"Impossible de finaliser l’inscription."});
  }
});

app.get("/api/me", (req,res) => {
  const user = currentUser(req);
  res.json({loggedIn: !!user, user: user || null});
});

app.get('/api/profile/me', (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:'Connexion requise.'});
  const row = db.prepare('SELECT id,email,display_name,bio,profile_photo,subscription_status FROM users WHERE id=?').get(user.id);
  res.json({profile:row});
});

app.post('/api/profile/me', (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:'Connexion requise.'});
  const displayName=String(req.body.displayName||'').trim().slice(0,40);
  const bio=String(req.body.bio||'').trim().slice(0,300);
  const profilePhoto=String(req.body.profilePhoto||'').trim().slice(0,500);
  if(!displayName) return res.status(400).json({error:'Le pseudo est obligatoire.'});
  if(profilePhoto && !/^https?:\/\//i.test(profilePhoto)) return res.status(400).json({error:'La photo de profil doit être une adresse https:// ou http://.'});
  db.prepare('UPDATE users SET display_name=?,bio=?,profile_photo=? WHERE id=?').run(displayName,bio,profilePhoto,user.id);
  logSecurity(user.id,'profile_update','Profil modifié');
  res.json({ok:true});
});

function clientIp(req){ return String((req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || 'unknown').slice(0,100); }
function logSecurity(userId,type,detail=''){ try { db.prepare('INSERT INTO security_events(user_id,type,detail) VALUES(?,?,?)').run(userId||null,type,String(detail).slice(0,300)); } catch {} }
function securitySettings(userId){ return db.prepare('SELECT security_enabled,link_protection,spam_protection FROM user_settings WHERE user_id=?').get(userId) || {security_enabled:1,link_protection:1,spam_protection:1}; }
function checkRate(user, req, kind, max, windowMinutes){ const st=securitySettings(user.id); if(!st.security_enabled || !st.spam_protection) return true; const since=new Date(Date.now()-windowMinutes*60000).toISOString().replace('T',' ').replace('Z','').slice(0,19); const ip=clientIp(req); const row=db.prepare("SELECT COUNT(*) c FROM security_events WHERE user_id=? AND type=? AND created_at>=?").get(user.id,kind,since); if(row.c>=max){ logSecurity(user.id,'rate_limit',kind); return false; } return true; }
function protectUserText(userId, value){ const st=securitySettings(userId); if(!st.security_enabled || !st.link_protection) return {blocked:false}; const text=String(value||''); const low=text.toLowerCase(); const badSchemes=/(javascript:|data:text\/html|vbscript:)/i; const suspicious=/(https?:\/\/[^\s]+@|https?:\/\/(?:bit\.ly|tinyurl\.com|t\.co)\/[^\s]*|https?:\/\/[^\s]*(?:login|verify|password|wallet|credential)[^\s]*)/i; if(badSchemes.test(text)) return {blocked:true,reason:'lien dangereux'}; if(suspicious.test(text)) return {blocked:true,reason:'lien potentiellement frauduleux'}; return {blocked:false}; }

app.post("/api/register", async (req,res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim().slice(0,40);
  const password = String(req.body.password || "");
  if (!email || !email.includes("@") || password.length < 8 || !displayName)
    return res.status(400).json({error:"Pseudo, courriel ou mot de passe invalide (8 caractères minimum)."});

  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users(email,display_name,password_hash,subscription_status) VALUES(?,?,?,?)").run(email, displayName, hash, "inactive");
    req.session.userId = Number(result.lastInsertRowid); createSession(req, Number(result.lastInsertRowid));
    db.prepare("INSERT OR IGNORE INTO free_subscribers(email,display_name) VALUES(?,?)").run(email, displayName);
    res.json({ok:true});
  } catch {
    res.status(409).json({error:"Ce courriel existe déjà."});
  }
});

app.post("/api/access", async (req,res) => {
  const email=String(req.body.email||'').trim().toLowerCase();
  const displayName=String(req.body.displayName||'').trim().slice(0,40);
  const password=String(req.body.password||'');
  if(!email || !email.includes("@") || password.length<8)
    return res.status(400).json({error:"Courriel ou mot de passe invalide (8 caractères minimum)."});

  const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);

  // Compte déjà existant : on utilise exactement le même parcours que la connexion normale.
  if(user){
    const ip=clientIp(req);
    const since=new Date(Date.now()-15*60000).toISOString().replace('T',' ').replace('Z','').slice(0,19);
    const recent=db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE email=? AND ip=? AND success=0 AND created_at>=?').get(email,ip,since).c;
    if(recent>=5)return res.status(429).json({error:'Trop de tentatives. Réessaie dans quelques minutes.'});
    if(!(await bcrypt.compare(password,user.password_hash))){
      db.prepare('INSERT INTO login_attempts(ip,email,success) VALUES(?,?,0)').run(ip,email);
      logSecurity(user.id,'login_failed','Tentative de connexion échouée');
      return res.status(401).json({error:'Courriel ou mot de passe incorrect.'});
    }
    db.prepare('INSERT INTO login_attempts(ip,email,success) VALUES(?,?,1)').run(ip,email);
    try{
      const id=await createVerification(user.id,'login');
      req.session.pendingLoginUserId=user.id;
      req.session.pendingLoginVerificationId=Number(id);
      logSecurity(user.id,'login_code_sent','Code de connexion envoyé par courriel');
      return res.json({ok:true,requiresCode:true,message:'Un code de sécurité a été envoyé à ton adresse courriel.'});
    }catch(e){
      return res.status(503).json({error:e.message||'Impossible d’envoyer le code de sécurité.'});
    }
  }

  // Nouveau compte : création automatique puis connexion immédiate.
  if(!displayName)
    return res.status(400).json({error:"Entre ton nom ou ton pseudo pour créer ton compte."});
  try{
    const hash=await bcrypt.hash(password,12);
    const result=db.prepare("INSERT INTO users(email,display_name,password_hash,subscription_status) VALUES(?,?,?,?)")
      .run(email,displayName,hash,"inactive");
    const userId=Number(result.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO free_subscribers(email,display_name) VALUES(?,?)").run(email,displayName);
    createSession(req,userId);
    return res.json({ok:true,created:true});
  }catch(e){
    return res.status(409).json({error:"Ce courriel existe déjà. Essaie de te connecter."});
  }
});

app.post("/api/login", async (req,res) => {
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||''), ip=clientIp(req);
  const since=new Date(Date.now()-15*60000).toISOString().replace('T',' ').replace('Z','').slice(0,19);
  const recent=db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE email=? AND ip=? AND success=0 AND created_at>=?').get(email,ip,since).c;
  if(recent>=5)return res.status(429).json({error:'Trop de tentatives. Réessaie dans quelques minutes.'});
  const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if(!user || !(await bcrypt.compare(password,user.password_hash))){db.prepare('INSERT INTO login_attempts(ip,email,success) VALUES(?,?,0)').run(ip,email);if(user)logSecurity(user.id,'login_failed','Tentative de connexion échouée');return res.status(401).json({error:'Courriel ou mot de passe incorrect.'});}
  db.prepare('INSERT INTO login_attempts(ip,email,success) VALUES(?,?,1)').run(ip,email);
  try{const id=await createVerification(user.id,'login');req.session.pendingLoginUserId=user.id;req.session.pendingLoginVerificationId=Number(id);logSecurity(user.id,'login_code_sent','Code de connexion envoyé par courriel');res.json({ok:true,requiresCode:true,message:'Un code de sécurité a été envoyé à ton adresse courriel.'});}
  catch(e){res.status(503).json({error:e.message||'Impossible d’envoyer le code de sécurité.'});}
});
app.post('/api/login/verify',async(req,res)=>{
  const userId=Number(req.session?.pendingLoginUserId||0), verificationId=Number(req.session?.pendingLoginVerificationId||0), code=String(req.body.code||'').replace(/\D/g,'').slice(0,6);
  if(!userId||!verificationId)return res.status(400).json({error:'Aucune connexion en attente. Recommence la connexion.'});
  const v=db.prepare("SELECT * FROM email_verifications WHERE id=? AND user_id=? AND purpose='login' AND used_at IS NULL").get(verificationId,userId);
  if(!v)return res.status(400).json({error:'Code invalide ou expiré. Recommence la connexion.'});
  if(new Date(String(v.expires_at).replace(' ','T')+'Z').getTime()<Date.now())return res.status(400).json({error:'Le code a expiré. Demande un nouveau code.'});
  if(v.attempts>=5)return res.status(429).json({error:'Trop de codes incorrects. Demande un nouveau code.'});
  if(verificationHash(code)!==v.code_hash){db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE id=?').run(v.id);logSecurity(userId,'login_code_failed','Code de connexion incorrect');return res.status(401).json({error:'Code incorrect.'});}
  db.prepare('UPDATE email_verifications SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(v.id);const user=db.prepare('SELECT id,email,display_name,subscription_status,session_version FROM users WHERE id=?').get(userId);
  req.session.pendingLoginUserId=null;req.session.pendingLoginVerificationId=null;req.session.userId=user.id;createSession(req,user.id);logSecurity(user.id,'login_2fa_success','Connexion confirmée par code courriel');res.json({ok:true});
});
app.post('/api/login/resend-code',async(req,res)=>{const userId=Number(req.session?.pendingLoginUserId||0);if(!userId)return res.status(400).json({error:'Aucune connexion en attente.'});try{const id=await createVerification(userId,'login');req.session.pendingLoginVerificationId=Number(id);logSecurity(userId,'login_code_resent','Nouveau code de connexion envoyé');res.json({ok:true});}catch(e){res.status(429).json({error:e.message||'Impossible de renvoyer le code.'});}});

app.post("/api/logout", (req,res) => {
  if(req.session?.sessionId) { try { db.prepare("DELETE FROM user_sessions WHERE id=?").run(req.session.sessionId); } catch {} }
  req.session = null;
  res.json({ok:true});
});

app.post("/api/change-password",async(req,res)=>{const user=currentUser(req);if(!user)return res.status(401).json({error:"Connecte-toi d'abord."});const password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'Le mot de passe doit contenir au moins 8 caractères.'});try{const hash=await bcrypt.hash(password,12);const id=await createVerification(user.id,'password_change',hash);req.session.pendingPasswordVerificationId=Number(id);logSecurity(user.id,'password_code_sent','Code envoyé pour confirmer le changement de mot de passe');res.json({ok:true,requiresCode:true,message:'Un code de sécurité a été envoyé à ton adresse courriel.'});}catch(e){res.status(503).json({error:e.message||'Impossible d’envoyer le code.'});}});
app.post('/api/change-password/verify',async(req,res)=>{const user=currentUser(req);if(!user)return res.status(401).json({error:"Connecte-toi d'abord."});const id=Number(req.session?.pendingPasswordVerificationId||0),code=String(req.body.code||'').replace(/\D/g,'').slice(0,6);if(!id)return res.status(400).json({error:'Aucun changement de mot de passe en attente.'});const v=db.prepare("SELECT * FROM email_verifications WHERE id=? AND user_id=? AND purpose='password_change' AND used_at IS NULL").get(id,user.id);if(!v)return res.status(400).json({error:'Code invalide ou expiré. Recommence la procédure.'});if(new Date(String(v.expires_at).replace(' ','T')+'Z').getTime()<Date.now())return res.status(400).json({error:'Le code a expiré. Recommence la procédure.'});if(v.attempts>=5)return res.status(429).json({error:'Trop de codes incorrects. Recommence la procédure.'});if(verificationHash(code)!==v.code_hash){db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE id=?').run(v.id);logSecurity(user.id,'password_code_failed','Code de changement de mot de passe incorrect');return res.status(401).json({error:'Code incorrect.'});}db.prepare('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?').run(v.new_password_hash,user.id);db.prepare('UPDATE email_verifications SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(v.id);db.prepare('DELETE FROM user_sessions WHERE user_id=? AND id<>?').run(user.id,req.session.sessionId);const fresh=db.prepare('SELECT session_version FROM users WHERE id=?').get(user.id);req.session.sessionVersion=fresh.session_version;req.session.pendingPasswordVerificationId=null;logSecurity(user.id,'password_changed','Mot de passe modifié après confirmation par code courriel');res.json({ok:true});});

app.post("/api/create-checkout-session", async (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});

  if (!stripe || !process.env.STRIPE_PRICE_ID) return res.status(503).json({error:"Stripe n’est pas configuré sur le serveur."});

  try {
    let customerId = db.prepare("SELECT stripe_customer_id FROM users WHERE id=?").get(user.id)?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({email: user.email});
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id=? WHERE id=?").run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{price: process.env.STRIPE_PRICE_ID, quantity: 1}],
      success_url: `${process.env.BASE_URL}/vip.html?success=1`,
      cancel_url: `${process.env.BASE_URL}/vip.html?canceled=1`,
      allow_promotion_codes: true,
    });
    res.json({url: session.url});
  } catch (e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/create-portal-session", async (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const row = db.prepare("SELECT stripe_customer_id FROM users WHERE id=?").get(user.id);
  if (!row?.stripe_customer_id) return res.status(400).json({error:"Aucun abonnement Stripe trouvé."});

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${process.env.BASE_URL}/vip.html`
    });
    res.json({url: session.url});
  } catch (e) {
    res.status(500).json({error:e.message});
  }
});

app.get("/api/subscription", async (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const row = db.prepare("SELECT stripe_customer_id,subscription_id,subscription_status,cancel_at_period_end FROM users WHERE id=?").get(user.id);
  if (!row?.subscription_id) return res.json({subscribed:false,status:row?.subscription_status || "inactive"});
  try {
    const sub = await stripe.subscriptions.retrieve(row.subscription_id);
    const item = sub.items.data[0];
    res.json({
      subscribed:["active","trialing"].includes(sub.status),
      status:sub.status,
      cancelAtPeriodEnd:!!sub.cancel_at_period_end,
      currentPeriodEnd:sub.current_period_end ? new Date(sub.current_period_end*1000).toISOString() : null,
      amount:item?.price?.unit_amount ?? null,
      currency:item?.price?.currency ?? "cad",
      interval:item?.price?.recurring?.interval ?? "month"
    });
  } catch (e) {
    res.status(500).json({error:"Impossible de récupérer l'abonnement."});
  }
});

app.post("/api/subscription/cancel", async (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const row = db.prepare("SELECT subscription_id FROM users WHERE id=?").get(user.id);
  if (!row?.subscription_id) return res.status(400).json({error:"Aucun abonnement actif."});
  try {
    const sub = await stripe.subscriptions.update(row.subscription_id, {cancel_at_period_end:true});
    db.prepare("UPDATE users SET subscription_status=?,cancel_at_period_end=? WHERE id=?").run(sub.status,1,user.id);
    res.json({ok:true,cancelAtPeriodEnd:true,currentPeriodEnd:sub.current_period_end ? new Date(sub.current_period_end*1000).toISOString() : null});
  } catch (e) { res.status(500).json({error:"Impossible de programmer l'annulation."}); }
});

app.post("/api/subscription/resume", async (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const row = db.prepare("SELECT subscription_id FROM users WHERE id=?").get(user.id);
  if (!row?.subscription_id) return res.status(400).json({error:"Aucun abonnement trouvé."});
  try {
    const sub = await stripe.subscriptions.update(row.subscription_id, {cancel_at_period_end:false});
    db.prepare("UPDATE users SET subscription_status=?,cancel_at_period_end=? WHERE id=?").run(sub.status,0,user.id);
    res.json({ok:true,cancelAtPeriodEnd:false});
  } catch (e) { res.status(500).json({error:"Impossible de réactiver l'abonnement."}); }
});

app.get("/api/premium-ranking", (req,res) => {
  const rows = db.prepare(`
    SELECT display_name, email, created_at
    FROM users
    WHERE subscription_status IN ('active','trialing')
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `).all();
  const freeRows = db.prepare(`SELECT display_name, created_at FROM free_subscribers ORDER BY created_at ASC, id ASC LIMIT 100`).all();
  const ranking = rows.map((row, index) => ({
    rank: index + 1,
    name: row.display_name || row.email.split('@')[0],
    status: 'VIP',
    joinedAt: row.created_at
  }));
  const freeRanking = freeRows.map((row, index) => ({
    rank: index + 1,
    name: row.display_name || 'Fan d’Evan',
    status: 'FREE',
    joinedAt: row.created_at
  }));
  res.json({count: ranking.length, freeCount: freeRanking.length, ranking, freeRanking});
});

app.get("/api/profile/:name", (req,res) => {
  const name=String(req.params.name||'').trim().slice(0,40);
  if(!name) return res.status(400).json({error:"Pseudo requis."});
  const row=db.prepare("SELECT display_name,subscription_status FROM users WHERE lower(display_name)=lower(?) LIMIT 1").get(name);
  if(!row) return res.status(404).json({error:"Profil introuvable."});
  const isVip=["active","trialing"].includes(row.subscription_status);
  // Seuls le pseudo et le statut FREE/VIP sont publics. Courriel, activité, paramètres, sécurité et autres données restent privés.
  res.json({profile:{name:row.display_name,status:isVip?'VIP':'FREE'}});
});

app.get("/api/dashboard", (req,res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const isVip = ["active","trialing"].includes(user.subscription_status);
  const favorites = db.prepare("SELECT title,created_at FROM favorites WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(user.id);
  const activity = db.prepare("SELECT title,action,created_at FROM activity WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id);
  const playlists = db.prepare("SELECT id,name,created_at FROM playlists WHERE user_id=? ORDER BY created_at DESC").all(user.id);
  const anns = db.prepare("SELECT id,title,message,created_at FROM announcements WHERE vip_only=0 OR vip_only=? ORDER BY created_at DESC LIMIT 20").all(isVip ? 1 : 0);
  const freeCount = db.prepare("SELECT COUNT(*) c FROM users WHERE subscription_status='inactive'").get().c;
  const vipCount = db.prepare("SELECT COUNT(*) c FROM users WHERE subscription_status IN ('active','trialing')").get().c;
  res.json({user,isVip,badge:isVip?'VIP':'FREE',favorites,activity,playlists,announcements:anns,counts:{free:freeCount,vip:vipCount}});
});

app.post("/api/favorites/toggle", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const title=String(req.body.title||'').trim().slice(0,120); if(!title) return res.status(400).json({error:"Titre requis."});
  const exists=db.prepare("SELECT id FROM favorites WHERE user_id=? AND title=?").get(user.id,title);
  if(exists) db.prepare("DELETE FROM favorites WHERE id=?").run(exists.id); else db.prepare("INSERT INTO favorites(user_id,title) VALUES(?,?)").run(user.id,title);
  res.json({ok:true,favorite:!exists});
});

app.post("/api/activity", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const title=String(req.body.title||'').trim().slice(0,120); const action=String(req.body.action||'Écouté').trim().slice(0,40);
  if(!title) return res.status(400).json({error:"Titre requis."});
  db.prepare("INSERT INTO activity(user_id,title,action) VALUES(?,?,?)").run(user.id,title,action);
  notify(user.id,'activity','Activité enregistrée',`+10 XP · ${action} : ${title}`);
  db.prepare("DELETE FROM activity WHERE user_id=? AND id NOT IN (SELECT id FROM activity WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20)").run(user.id,user.id);
  res.json({ok:true});
});

app.post("/api/playlists", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const name=String(req.body.name||'').trim().slice(0,60); if(!name) return res.status(400).json({error:"Nom de playlist requis."});
  try { const r=db.prepare("INSERT INTO playlists(user_id,name) VALUES(?,?)").run(user.id,name); res.json({ok:true,id:r.lastInsertRowid,name}); } catch { res.status(409).json({error:"Cette playlist existe déjà."}); }
});

app.post("/api/playlists/item", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const playlistId=Number(req.body.playlistId); const title=String(req.body.title||'').trim().slice(0,120);
  const pl=db.prepare("SELECT id FROM playlists WHERE id=? AND user_id=?").get(playlistId,user.id); if(!pl) return res.status(404).json({error:"Playlist introuvable."});
  if(!title) return res.status(400).json({error:"Titre requis."});
  db.prepare("INSERT OR IGNORE INTO playlist_items(playlist_id,title) VALUES(?,?)").run(playlistId,title); res.json({ok:true});
});

app.post("/api/likes/toggle", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi pour aimer ce contenu."});
  const type=String(req.body.contentType||'').trim().slice(0,30), title=String(req.body.contentTitle||'').trim().slice(0,120);
  if(!type||!title) return res.status(400).json({error:"Contenu invalide."});
  const exists=db.prepare("SELECT id FROM likes WHERE user_id=? AND content_type=? AND content_title=?").get(user.id,type,title);
  if(exists) db.prepare("DELETE FROM likes WHERE id=?").run(exists.id); else db.prepare("INSERT INTO likes(user_id,content_type,content_title) VALUES(?,?,?)").run(user.id,type,title);
  const count=db.prepare("SELECT COUNT(*) c FROM likes WHERE content_type=? AND content_title=?").get(type,title).c;
  res.json({ok:true,liked:!exists,count});
});

app.get("/api/comments", (req,res) => {
  const type=String(req.query.contentType||''); const title=String(req.query.contentTitle||'');
  const comments=db.prepare("SELECT c.id,c.body,c.created_at,u.display_name author,CASE WHEN u.subscription_status IN ('active','trialing') THEN 'VIP' ELSE 'FREE' END status FROM comments c JOIN users u ON u.id=c.user_id WHERE c.content_type=? AND c.content_title=? ORDER BY c.created_at ASC,c.id ASC").all(type,title);
  const replies=db.prepare("SELECT r.id,r.comment_id,r.body,r.created_at,u.display_name author,CASE WHEN u.subscription_status IN ('active','trialing') THEN 'VIP' ELSE 'FREE' END status FROM comment_replies r JOIN users u ON u.id=r.user_id WHERE r.comment_id IN (SELECT id FROM comments WHERE content_type=? AND content_title=?) ORDER BY r.created_at ASC,r.id ASC").all(type,title);
  res.json({comments:comments.map(c=>({...c,replies:replies.filter(r=>r.comment_id===c.id)}))});
});
app.post("/api/comments", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi pour commenter."});
  const type=String(req.body.contentType||'').trim().slice(0,30), title=String(req.body.contentTitle||'').trim().slice(0,120), body=String(req.body.body||'').trim().slice(0,500);
  if(!type||!title||!body) return res.status(400).json({error:"Commentaire incomplet."});
  if(!checkRate(user,req,'comment',10,5)) return res.status(429).json({error:'Trop de commentaires rapidement. Réessaie plus tard.'});
  const m=moderateText(body); if(m.blocked) return res.status(400).json({error:'Commentaire bloqué : contenu interdit détecté ('+m.category+').'});
  const lp=protectUserText(user.id,body); if(lp.blocked) return res.status(400).json({error:'Commentaire bloqué : '+lp.reason+'.'});
  const r=db.prepare("INSERT INTO comments(user_id,content_type,content_title,body) VALUES(?,?,?,?)").run(user.id,type,title,body);
  const admin=db.prepare("SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1").get(process.env.ADMIN_EMAIL||"none");
  if(admin && admin.id!==user.id) notify(admin.id,'comment','Nouveau commentaire',`${user.display_name} a commenté ${title}`);
  res.json({ok:true,id:r.lastInsertRowid});
});
app.post("/api/comments/reply", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi pour répondre."});
  const id=Number(req.body.commentId), body=String(req.body.body||'').trim().slice(0,500); if(!id||!body) return res.status(400).json({error:"Réponse invalide."});
  if(!checkRate(user,req,'reply',15,5)) return res.status(429).json({error:'Trop de réponses rapidement. Réessaie plus tard.'});
  const m=moderateText(body); if(m.blocked) return res.status(400).json({error:'Réponse bloquée : contenu interdit détecté ('+m.category+').'});
  const lp=protectUserText(user.id,body); if(lp.blocked) return res.status(400).json({error:'Réponse bloquée : '+lp.reason+'.'});
  if(!db.prepare("SELECT id FROM comments WHERE id=?").get(id)) return res.status(404).json({error:"Commentaire introuvable."});
  const r=db.prepare("INSERT INTO comment_replies(comment_id,user_id,body) VALUES(?,?,?)").run(id,user.id,body);
  const owner=db.prepare("SELECT user_id,content_title FROM comments WHERE id=?").get(id);
  if(owner && owner.user_id!==user.id) notify(owner.user_id,'reply','Nouvelle réponse',`${user.display_name} a répondu à ton commentaire sur ${owner.content_title}`);
  res.json({ok:true,id:r.lastInsertRowid});
});
app.post("/api/comments/report", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi pour signaler un commentaire."});
  const id=Number(req.body.commentId), reason=String(req.body.reason||'Autre').trim().slice(0,80); if(!id) return res.status(400).json({error:"Commentaire invalide."});
  try { db.prepare("INSERT INTO comment_reports(comment_id,user_id,reason) VALUES(?,?,?)").run(id,user.id,reason||'Autre'); } catch { return res.status(409).json({error:"Tu as déjà signalé ce commentaire."}); }
  res.json({ok:true,message:"Commentaire signalé. Merci."});
});

app.get("/api/settings", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const row=db.prepare("SELECT theme,notifications,compact_mode FROM user_settings WHERE user_id=?").get(user.id) || {theme:'system',notifications:1,compact_mode:0}; res.json({settings:row});
});
app.post("/api/settings", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const theme=['system','light','dark'].includes(req.body.theme)?req.body.theme:'system'; const notifications=req.body.notifications===false?0:1; const compact=req.body.compactMode===true?1:0;
  db.prepare("INSERT INTO user_settings(user_id,theme,notifications,compact_mode) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,notifications=excluded.notifications,compact_mode=excluded.compact_mode").run(user.id,theme,notifications,compact); res.json({ok:true,settings:{theme,notifications,compact_mode:compact}});
});
function moderateText(value){
  const text=String(value||'').toLowerCase();
  const rules=[
    {category:'contenu sexuel explicite', words:['porn','porno','pornographie','xxx','sexcam','nude','nudity','hentai']},
    {category:'piratage / malware', words:['ransomware','malware','keylogger','stealer','ddos','botnet','crack','pirater un compte','voler un compte','phishing','credential']},
    {category:'vente ou trafic illégal', words:['drogue a vendre','armes a vendre','vente de drogue','trafic']},
    {category:'exploitation sexuelle de mineurs', words:['csam','child porn','pedo','pédopornographie']}
  ];
  for(const rule of rules) if(rule.words.some(w=>text.includes(w))) return {blocked:true,category:rule.category};
  return {blocked:false};
}

app.get("/api/projects", (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  const projects=db.prepare('SELECT id,name,description,created_at,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(u.id);
  for(const pr of projects) pr.folders=db.prepare('SELECT id,name,created_at FROM project_folders WHERE project_id=? ORDER BY name').all(pr.id);
  res.json({projects});
});
app.post("/api/projects", (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  const name=String(req.body.name||'').trim().slice(0,80), description=String(req.body.description||'').trim().slice(0,500);
  if(!name) return res.status(400).json({error:'Donne un nom au projet.'});
  if(!checkRate(u,req,'project',10,10)) return res.status(429).json({error:'Trop de modifications de projets rapidement.'});
  const m=moderateText(name+' '+description); if(m.blocked) return res.status(400).json({error:'Projet bloqué : contenu interdit détecté ('+m.category+').'});
  const lp=protectUserText(u.id,name+' '+description); if(lp.blocked) return res.status(400).json({error:'Projet bloqué : '+lp.reason+'.'});
  const r=db.prepare('INSERT INTO projects(user_id,name,description) VALUES(?,?,?)').run(u.id,name,description);
  res.json({ok:true,id:r.lastInsertRowid});
});
app.post("/api/projects/folder", (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  const projectId=Number(req.body.projectId), name=String(req.body.name||'').trim().slice(0,80);
  const pr=db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(projectId,u.id);
  if(!pr) return res.status(404).json({error:'Projet introuvable.'});
  if(!name) return res.status(400).json({error:'Donne un nom au dossier.'});
  const m=moderateText(name); if(m.blocked) return res.status(400).json({error:'Dossier bloqué : contenu interdit détecté ('+m.category+').'});
  try { db.prepare('INSERT INTO project_folders(project_id,name) VALUES(?,?)').run(projectId,name); db.prepare('UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(projectId); res.json({ok:true}); } catch(e){ res.status(409).json({error:'Ce dossier existe déjà.'}); }
});

app.get('/api/security', (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  const st=securitySettings(u.id);
  const events=db.prepare('SELECT type,detail,created_at FROM security_events WHERE user_id=? ORDER BY id DESC LIMIT 20').all(u.id);
  const sessions=db.prepare('SELECT id,ip,user_agent,created_at,last_seen FROM user_sessions WHERE user_id=? ORDER BY last_seen DESC').all(u.id).map(x=>({...x,current:x.id===req.session.sessionId}));
  res.json({enabled:!!st.security_enabled,linkProtection:!!st.link_protection,spamProtection:!!st.spam_protection,sessions,events});
});
app.post('/api/security/settings', (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  const enabled=req.body.enabled!==false?1:0, links=req.body.linkProtection!==false?1:0, spam=req.body.spamProtection!==false?1:0;
  db.prepare('INSERT INTO user_settings(user_id,security_enabled,link_protection,spam_protection) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET security_enabled=excluded.security_enabled,link_protection=excluded.link_protection,spam_protection=excluded.spam_protection').run(u.id,enabled,links,spam);
  logSecurity(u.id,enabled?'security_enabled':'security_disabled',enabled?'Protections activées':'Protections désactivées par le propriétaire du compte');
  res.json({ok:true,enabled:!!enabled,linkProtection:!!links,spamProtection:!!spam});
});
app.delete('/api/security/events', (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  db.prepare('DELETE FROM security_events WHERE user_id=?').run(u.id);
  res.json({ok:true});
});
app.delete('/api/sessions/:id',(req,res)=>{ const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'}); const id=String(req.params.id); if(id===req.session.sessionId) return res.status(400).json({error:'Utilise Déconnexion pour la session actuelle.'}); db.prepare('DELETE FROM user_sessions WHERE id=? AND user_id=?').run(id,u.id); res.json({ok:true}); });

app.post('/api/logout-all', (req,res) => {
  const u=currentUser(req); if(!u) return res.status(401).json({error:'Connexion requise.'});
  db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(u.id);
  db.prepare('DELETE FROM user_sessions WHERE user_id=?').run(u.id);
  logSecurity(u.id,'logout_all','Toutes les sessions ont été invalidées');
  req.session=null;
  res.json({ok:true});
});

app.get("/api/rewards", (req,res) => {
  const user=currentUser(req); if(!user) return res.status(401).json({error:"Connecte-toi d'abord."});
  const activity=db.prepare("SELECT COUNT(*) c FROM activity WHERE user_id=?").get(user.id).c;
  const likes=db.prepare("SELECT COUNT(*) c FROM likes WHERE user_id=?").get(user.id).c;
  const comments=db.prepare("SELECT COUNT(*) c FROM comments WHERE user_id=?").get(user.id).c;
  const replies=db.prepare("SELECT COUNT(*) c FROM comment_replies WHERE user_id=?").get(user.id).c;
  const days=Math.max(0,Math.floor((Date.now()-new Date(user.created_at).getTime())/86400000));
  const xp=25+(activity*10)+(likes*5)+(comments*15)+(replies*10)+(days>=7?25:0)+(['active','trialing'].includes(user.subscription_status)?100:0);
  const level=Math.max(1,Math.floor(xp/100)+1), next=level*100;
  const defs=[
    ['new','🌱 Nouveau membre','Créer son compte',true],
    ['active','🔥 Membre actif','5 actions sur le site',activity+likes+comments+replies>=5],
    ['fan','❤️ Fan','Aimer 5 contenus',likes>=5],
    ['commenter','💬 Bavard','Publier 3 commentaires',comments>=3],
    ['social','🤝 Social','Répondre à 3 commentaires',replies>=3],
    ['vip','👑 VIP','Être membre VIP actif',['active','trialing'].includes(user.subscription_status)],
    ['top','🏆 Top membre','Atteindre le niveau 10',level>=10]
  ];
  for(const d of defs.filter(x=>x[3])) db.prepare("INSERT OR IGNORE INTO badges(user_id,badge_key,badge_name) VALUES(?,?,?)").run(user.id,d[0],d[1]);
  res.json({xp,level,nextLevelXp:next,stats:{activity,likes,comments,replies},badges:defs.map(d=>({key:d[0],name:d[1],description:d[2],unlocked:d[3]}))});
});

app.get("/api/announcements", (req,res) => {
  const user=currentUser(req); const isVip=!!user && ["active","trialing"].includes(user.subscription_status);
  const rows=db.prepare("SELECT title,message,created_at FROM announcements WHERE vip_only=0 OR vip_only=? ORDER BY created_at DESC LIMIT 20").all(isVip?1:0);
  res.json({announcements:rows});
});

app.get("/api/vip-content", (req,res) => {
  const user = currentUser(req);
  if (!user || !["active","trialing"].includes(user.subscription_status))
    return res.status(403).json({error:"Contenu réservé aux membres VIP."});
  res.json({
    ok:true,
    content:[
      "🎵 Avant-premières des nouvelles chansons",
      "🎬 Contenus exclusifs",
      "⭐ Actualités réservées aux membres"
    ]
  });
});

app.listen(port, "0.0.0.0", () => console.log(`Evan VIP: http://0.0.0.0:${port}`));
