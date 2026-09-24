import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "ADMIN_TOKEN"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors({
  origin: process.env.APP_ORIGIN ? process.env.APP_ORIGIN.split(",").map(v => v.trim()) : false
}));
app.use(express.json({ limit: "32kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.use("/api/auth", authLimiter);
app.use("/api/deposits", moneyLimiter);
app.use("/api/withdrawals", moneyLimiter);
app.use("/api/missions", moneyLimiter);

const phoneSchema = z.string().transform(v => v.replace(/\D/g, "")).refine(
  v => /^(84|85|86|87)\d{7}$/.test(v),
  "Número moçambicano inválido."
);

const pinSchema = z.string().regex(/^\d{4,6}$/, "O PIN deve ter 4 a 6 dígitos numéricos.");
const allowedDeposits = new Set([850, 1500, 3000, 5000, 10000, 30000]);

function maputoDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Maputo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function operatorFromPhone(phone) {
  return phone.startsWith("84") || phone.startsWith("85") ? "M-Pesa" : "E-Mola";
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: "12h", issuer: "vectra-watch" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sessão necessária." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: "vectra-watch" });
    req.user = { id: payload.sub, phone: payload.phone };
    next();
  } catch {
    res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}

function admin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Acesso administrativo negado." });
  }
  next();
}

function dbError(res, error, fallback = "Não foi possível concluir a operação.") {
  console.error(error);
  const message = String(error?.message || "");
  const known = {
    RUN_NOT_FOUND: "Execução da missão não encontrada.",
    RUN_ALREADY_COMPLETED: "Esta execução já foi concluída.",
    WATCH_TIME_NOT_REACHED: "O tempo mínimo de monitoria ainda não terminou.",
    MISSION_INACTIVE: "Esta missão já não está ativa.",
    MISSION_ALREADY_COMPLETED_TODAY: "Esta missão já foi concluída hoje.",
    MIN_WITHDRAWAL_400: "O levantamento mínimo é 400 MT.",
    INVALID_PHONE: "Número de carteira inválido.",
    INSUFFICIENT_AVAILABLE_BALANCE: "Saldo disponível insuficiente.",
    DEPOSIT_NOT_FOUND: "Depósito não encontrado.",
    DEPOSIT_ALREADY_PROCESSED: "Este depósito já foi processado.",
    WITHDRAWAL_NOT_FOUND: "Levantamento não encontrado.",
    WITHDRAWAL_ALREADY_PROCESSED: "Este levantamento já foi processado.",
    INVALID_ACTION: "Ação administrativa inválida."
  };
  const hit = Object.entries(known).find(([key]) => message.includes(key));
  return res.status(400).json({ error: hit ? hit[1] : fallback });
}

async function uniqueRefCode() {
  for (let i = 0; i < 8; i++) {
    const code = "VW" + crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const { data } = await supabase.from("users").select("id").eq("ref_code", code).maybeSingle();
    if (!data) return code;
  }
  throw new Error("REF_CODE_GENERATION_FAILED");
}

app.post("/api/auth/register", async (req, res) => {
  const parsed = z.object({
    phone: phoneSchema,
    pin: pinSchema,
    refCode: z.string().trim().toUpperCase().max(16).optional().default("")
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados inválidos." });
  }

  const { phone, pin, refCode } = parsed.data;
  const { data: existing } = await supabase.from("users").select("id").eq("phone", phone).maybeSingle();
  if (existing) return res.status(409).json({ error: "Este contacto já está registado." });

  let sponsorId = null;
  if (refCode) {
    const { data: sponsor } = await supabase.from("users").select("id").eq("ref_code", refCode).maybeSingle();
    if (!sponsor) return res.status(400).json({ error: "Código de convite inválido." });
    sponsorId = sponsor.id;
  }

  try {
    const pinHash = await bcrypt.hash(pin, 12);
    const ref_code = await uniqueRefCode();
    const { data: user, error: userError } = await supabase
      .from("users")
      .insert({ phone, pin_hash: pinHash, ref_code, sponsor_id: sponsorId })
      .select("id, phone, ref_code")
      .single();

    if (userError) throw userError;

    const { error: walletError } = await supabase
      .from("wallets")
      .insert({ user_id: user.id, available: 0, bonus: 50, locked: 0 });

    if (walletError) {
      await supabase.from("users").delete().eq("id", user.id);
      throw walletError;
    }

    res.status(201).json({
      token: issueToken(user),
      user: { phone: user.phone, refCode: user.ref_code }
    });
  } catch (error) {
    dbError(res, error, "Não foi possível criar a conta.");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ phone: phoneSchema, pin: pinSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Número ou PIN inválido." });

  const { data: user, error } = await supabase
    .from("users")
    .select("id, phone, pin_hash, ref_code")
    .eq("phone", parsed.data.phone)
    .maybeSingle();

  if (error || !user || !(await bcrypt.compare(parsed.data.pin, user.pin_hash))) {
    return res.status(401).json({ error: "Número ou PIN incorreto." });
  }

  res.json({
    token: issueToken(user),
    user: { phone: user.phone, refCode: user.ref_code }
  });
});

app.get("/api/me", auth, async (req, res) => {
  const [userResult, walletResult, referralsResult] = await Promise.all([
    supabase.from("users").select("phone, ref_code, created_at").eq("id", req.user.id).single(),
    supabase.from("wallets").select("available, bonus, locked").eq("user_id", req.user.id).single(),
    supabase.from("users").select("id", { count: "exact", head: true }).eq("sponsor_id", req.user.id)
  ]);

  if (userResult.error || walletResult.error) {
    return dbError(res, userResult.error || walletResult.error, "Não foi possível carregar a conta.");
  }

  res.json({
    user: {
      phone: userResult.data.phone,
      refCode: userResult.data.ref_code,
      referralsCount: referralsResult.count || 0
    },
    wallet: walletResult.data
  });
});

app.get("/api/missions", auth, async (req, res) => {
  const day = maputoDay();
  const [{ data: missions, error }, { data: completed }] = await Promise.all([
    supabase.from("missions").select("id, category, title, youtube_id, reward").eq("active", true).order("id"),
    supabase.from("mission_completions").select("mission_id").eq("user_id", req.user.id).eq("completion_day", day)
  ]);

  if (error) return dbError(res, error, "Não foi possível carregar as missões.");
  const completedSet = new Set((completed || []).map(x => Number(x.mission_id)));

  res.json({
    date: day,
    missions: (missions || []).map(m => ({
      id: Number(m.id),
      category: m.category,
      title: m.title,
      youtubeId: m.youtube_id,
      reward: Number(m.reward),
      done: completedSet.has(Number(m.id))
    }))
  });
});

app.post("/api/missions/:id/start", auth, async (req, res) => {
  const missionId = Number(req.params.id);
  if (!Number.isInteger(missionId) || missionId <= 0) {
    return res.status(400).json({ error: "Missão inválida." });
  }

  const day = maputoDay();
  const { data: done } = await supabase
    .from("mission_completions")
    .select("id")
    .eq("user_id", req.user.id)
    .eq("mission_id", missionId)
    .eq("completion_day", day)
    .maybeSingle();

  if (done) return res.status(409).json({ error: "Esta missão já foi concluída hoje." });

  const { data: mission } = await supabase
    .from("missions")
    .select("id")
    .eq("id", missionId)
    .eq("active", true)
    .maybeSingle();

  if (!mission) return res.status(404).json({ error: "Missão indisponível." });

  const { data: run, error } = await supabase
    .from("mission_runs")
    .insert({ user_id: req.user.id, mission_id: missionId })
    .select("id, started_at")
    .single();

  if (error) return dbError(res, error, "Não foi possível iniciar a missão.");
  res.status(201).json({ runId: run.id, startedAt: run.started_at, minimumSeconds: 10 });
});

app.post("/api/missions/runs/:runId/claim", auth, async (req, res) => {
  const { data, error } = await supabase.rpc("claim_mission", {
    p_user_id: req.user.id,
    p_run_id: req.params.runId
  });

  if (error) return dbError(res, error);
  const row = data?.[0];
  res.json({ reward: Number(row?.reward || 0), available: Number(row?.new_available || 0) });
});

app.get("/api/payment-config", auth, (_req, res) => {
  res.json({
    collectorPhone: process.env.COLLECTOR_PHONE || "870573840",
    collectorName: process.env.COLLECTOR_NAME || "Vectra Watch",
    collectorOperator: process.env.COLLECTOR_OPERATOR || "E-Mola"
  });
});

app.post("/api/deposits", auth, async (req, res) => {
  const parsed = z.object({
    amount: z.coerce.number().int().refine(v => allowedDeposits.has(v), "Montante de depósito inválido."),
    senderPhone: phoneSchema,
    transactionCode: z.string().trim().min(5).max(80)
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados de depósito inválidos." });
  }

  const externalRef = parsed.data.transactionCode.toUpperCase().replace(/\s+/g, "");
  const { data, error } = await supabase
    .from("transactions")
    .insert({
      user_id: req.user.id,
      kind: "deposit",
      amount: parsed.data.amount,
      status: "pending",
      phone: parsed.data.senderPhone,
      operator: operatorFromPhone(parsed.data.senderPhone),
      external_ref: externalRef
    })
    .select("id, status, created_at")
    .single();

  if (error) {
    if (String(error.message).toLowerCase().includes("duplicate")) {
      return res.status(409).json({ error: "Este código de transação já foi utilizado." });
    }
    return dbError(res, error, "Não foi possível registar o depósito.");
  }

  res.status(201).json({
    id: data.id,
    status: data.status,
    message: "Depósito recebido para validação. O saldo só será creditado após confirmação."
  });
});

app.post("/api/withdrawals", auth, async (req, res) => {
  const parsed = z.object({
    amount: z.coerce.number().positive(),
    phone: phoneSchema
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || "Dados de levantamento inválidos." });
  }

  const { data, error } = await supabase.rpc("request_withdrawal", {
    p_user_id: req.user.id,
    p_amount: parsed.data.amount,
    p_phone: parsed.data.phone,
    p_operator: operatorFromPhone(parsed.data.phone)
  });

  if (error) return dbError(res, error);
  res.status(201).json({ id: data, status: "pending" });
});

app.get("/api/transactions", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, kind, amount, status, operator, phone, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return dbError(res, error, "Não foi possível carregar o histórico.");
  res.json({
    transactions: (data || []).map(t => ({ ...t, amount: Number(t.amount) }))
  });
});

app.post("/api/admin/deposits/:id/approve", admin, async (req, res) => {
  const { error } = await supabase.rpc("approve_deposit", { p_tx_id: req.params.id });
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

app.post("/api/admin/deposits/:id/reject", admin, async (req, res) => {
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status")
    .eq("id", req.params.id)
    .eq("kind", "deposit")
    .maybeSingle();

  if (!tx) return res.status(404).json({ error: "Depósito não encontrado." });
  if (tx.status !== "pending") return res.status(409).json({ error: "Depósito já processado." });

  const { error } = await supabase
    .from("transactions")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("status", "pending");

  if (error) return dbError(res, error);
  res.json({ ok: true });
});

app.post("/api/admin/withdrawals/:id/:action", admin, async (req, res) => {
  if (!["approve", "reject"].includes(req.params.action)) {
    return res.status(400).json({ error: "Ação inválida." });
  }
  const { error } = await supabase.rpc("transition_withdrawal", {
    p_tx_id: req.params.id,
    p_action: req.params.action
  });
  if (error) return dbError(res, error);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "vectra-watch" });
});

app.use(express.static(publicDir, { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.listen(PORT, () => {
  console.log(`Vectra Watch listening on port ${PORT}`);
});
