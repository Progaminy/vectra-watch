const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const state = {
  token: sessionStorage.getItem("vw_token") || "",
  me: null,
  missions: [],
  selectedAmount: 850,
  paymentConfig: null,
  currentMission: null,
  currentRunId: null,
  ytPlayer: null,
  playing: false,
  secondsRemaining: 10,
  ticker: null,
  historyOpen: true,
  toastTimer: null
};

function money(v){ return Number(v || 0).toLocaleString("pt-PT",{minimumFractionDigits:2,maximumFractionDigits:2}) + " MT"; }
function cleanPhone(v){ return String(v || "").replace(/\D/g,"").slice(0,9); }
function validPhone(v){ return /^(84|85|86|87)\d{7}$/.test(cleanPhone(v)); }
function operator(v){
  const p=cleanPhone(v);
  if(/^8[45]/.test(p)) return "M-Pesa (Vodacom)";
  if(/^8[67]/.test(p)) return "E-Mola (Movitel)";
  return p.length>=2 ? "Operadora inválida" : "";
}
function showToast(msg){
  const el=$("#toast");
  el.textContent=msg;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer=setTimeout(()=>el.classList.remove("show"),2800);
}
async function api(path, options={}){
  const headers={...(options.headers||{})};
  if(options.body && !headers["Content-Type"]) headers["Content-Type"]="application/json";
  if(state.token) headers.Authorization="Bearer "+state.token;
  const res=await fetch(path,{...options,headers});
  let data={};
  try{ data=await res.json(); }catch{}
  if(res.status===401 && state.token && !path.startsWith("/api/auth/")){
    signOut(false);
    throw new Error(data.error || "Sessão expirada.");
  }
  if(!res.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
  return data;
}

function setSession(token){
  state.token=token || "";
  if(token) sessionStorage.setItem("vw_token",token);
  else sessionStorage.removeItem("vw_token");
}
function showAuth(){
  $("#authView").hidden=false;
  $("#mainApp").hidden=true;
}
function showApp(){
  $("#authView").hidden=true;
  $("#mainApp").hidden=false;
}
function setAuthMode(mode){
  const login=mode==="login";
  $("#loginForm").hidden=!login;
  $("#registerForm").hidden=login;
  $$("[data-auth-mode]").forEach(b=>b.classList.toggle("active",b.dataset.authMode===mode));
}
function switchNav(key){
  $$(".tab-view").forEach(t=>t.classList.toggle("active",t.id===`tab-${key}`));
  $$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.nav===key));
  if(key==="wallet") loadTransactions().catch(e=>showToast(e.message));
}

function bindPhone(inputSel,labelSel){
  const input=$(inputSel), label=$(labelSel);
  input.addEventListener("input",()=>{
    input.value=cleanPhone(input.value);
    const op=operator(input.value);
    label.textContent=op;
    label.style.color=op.includes("Inválida")?"#ef4444":op.includes("M-Pesa")?"#ef4444":op?"#f97316":"";
  });
}

async function bootstrap(){
  bindEvents();
  const ref=new URLSearchParams(location.search).get("ref");
  if(ref){
    setAuthMode("register");
    $("#regRefCode").value=ref.toUpperCase();
  }
  if(!state.token){ showAuth(); return; }
  try{
    await refreshAll();
    showApp();
  }catch(e){
    showToast(e.message);
    showAuth();
  }
}

function bindEvents(){
  $$("[data-auth-mode]").forEach(b=>b.addEventListener("click",()=>setAuthMode(b.dataset.authMode)));
  $$("[data-toggle-password]").forEach(btn=>btn.addEventListener("click",()=>{
    const input=$("#"+btn.dataset.togglePassword);
    const reveal=input.type==="password";
    input.type=reveal?"text":"password";
    btn.innerHTML=`<i class="fa-solid fa-eye${reveal?"-slash":""}"></i>`;
  }));
  $$("[data-nav]").forEach(b=>b.addEventListener("click",()=>switchNav(b.dataset.nav)));

  bindPhone("#regPhone","#regOperator");
  bindPhone("#depositPhone","#depositOperator");
  bindPhone("#withdrawPhone","#withdrawOperator");

  $("#loginForm").addEventListener("submit",login);
  $("#registerForm").addEventListener("submit",register);
  $("#depositForm").addEventListener("submit",submitDeposit);
  $("#withdrawForm").addEventListener("submit",submitWithdrawal);
  $("#refreshBtn").addEventListener("click",()=>refreshAll(true));
  $("#logoutBtn").addEventListener("click",()=>confirmDialog("Terminar sessão","Tem certeza que deseja sair desta conta?",()=>signOut(true)));
  $("#copyInviteBtn").addEventListener("click",copyInvite);
  $("#closeVideoBtn").addEventListener("click",closeVideoModal);
  $("#btnClaimReward").addEventListener("click",claimMission);
  $("#toggleHistoryBtn").addEventListener("click",toggleHistory);

  $$("#chipGrid .chip-item").forEach(btn=>btn.addEventListener("click",()=>{
    state.selectedAmount=Number(btn.dataset.amount);
    $$("#chipGrid .chip-item").forEach(b=>b.classList.toggle("active",b===btn));
  }));

  $("#confirmCancel").addEventListener("click",()=>$("#confirmModal").hidden=true);
}

async function login(ev){
  ev.preventDefault();
  const phone=cleanPhone($("#loginPhone").value);
  const pin=$("#loginPin").value.trim();
  if(!validPhone(phone)) return showToast("Insira um número moçambicano válido.");
  if(!/^\d{4,6}$/.test(pin)) return showToast("PIN inválido.");

  const btn=ev.submitter; btn.disabled=true;
  try{
    const data=await api("/api/auth/login",{method:"POST",body:JSON.stringify({phone,pin})});
    setSession(data.token);
    await refreshAll();
    showApp();
    switchNav("home");
    $("#loginForm").reset();
    showToast("Sessão iniciada.");
  }catch(e){ showToast(e.message); }
  finally{ btn.disabled=false; }
}

async function register(ev){
  ev.preventDefault();
  const phone=cleanPhone($("#regPhone").value);
  const pin=$("#regPin").value.trim();
  const confirm=$("#regPinConfirm").value.trim();
  const refCode=$("#regRefCode").value.trim().toUpperCase();

  if(!validPhone(phone)) return showToast("Insira um número moçambicano válido.");
  if(!/^\d{4,6}$/.test(pin)) return showToast("O PIN deve ter 4 a 6 números.");
  if(pin!==confirm) return showToast("Os PINs não são idênticos.");

  const btn=ev.submitter; btn.disabled=true;
  try{
    const data=await api("/api/auth/register",{method:"POST",body:JSON.stringify({phone,pin,refCode})});
    setSession(data.token);
    await refreshAll();
    showApp();
    switchNav("home");
    $("#registerForm").reset();
    showToast("Conta criada. Bónus promocional de 50 MT adicionado.");
  }catch(e){ showToast(e.message); }
  finally{ btn.disabled=false; }
}

async function refreshAll(withToast=false){
  await Promise.all([loadMe(),loadMissions(),loadPaymentConfig(),loadTransactions()]);
  renderAll();
  if(withToast) showToast("Dados atualizados.");
}

async function loadMe(){ state.me=await api("/api/me"); }
async function loadMissions(){
  const data=await api("/api/missions");
  state.missions=data.missions || [];
  $("#taskDateBadge").textContent=data.date || "";
}
async function loadPaymentConfig(){
  try{ state.paymentConfig=await api("/api/payment-config"); }
  catch{ state.paymentConfig=null; }
}
async function loadTransactions(){
  if(!state.token) return;
  const data=await api("/api/transactions");
  renderTransactions(data.transactions || []);
}

function renderAll(){
  renderMe();
  renderMissions();
  renderPaymentConfig();
}
function renderMe(){
  if(!state.me) return;
  const {user,wallet}=state.me;
  $("#userBadge span").textContent=`+258 ${user.phone}`;
  $("#profilePhone").textContent=`+258 ${user.phone}`;
  $("#userRefCode").textContent=user.refCode;
  $("#totalReferralsCount").textContent=user.referralsCount || 0;
  $("#dashBalance").textContent=money(wallet.available);
  $("#dashBonus").textContent=money(wallet.bonus);
  $("#dashLocked").textContent=money(wallet.locked);
}
function renderMissions(){
  const list=$("#missionsList");
  list.innerHTML="";
  if(!state.missions.length){
    list.innerHTML='<div class="empty">Sem missões disponíveis agora.</div>';
    $("#tasksBadge").hidden=true;
    return;
  }
  for(const m of state.missions){
    const card=document.createElement("article");
    card.className="mission-card"+(m.done?" done":"");
    card.innerHTML=`
      <div class="mission-header"><span class="tag">${escapeHtml(m.category)}</span><span class="reward">+${money(m.reward)}</span></div>
      <h4>${escapeHtml(m.title)}</h4>
      <div class="mission-action">
        <small><i class="fa-brands fa-youtube" style="color:#ef4444"></i> Validação pelo servidor</small>
        <button class="btn btn-green mission-start" ${m.done?"disabled":""}>${m.done?'<i class="fa-solid fa-check"></i> Avaliado':'<i class="fa-solid fa-play"></i> Iniciar'}</button>
      </div>`;
    if(!m.done) $(".mission-start",card).addEventListener("click",()=>openMission(m));
    list.appendChild(card);
  }
  const pending=state.missions.filter(m=>!m.done).length;
  $("#tasksBadge").textContent=pending;
  $("#tasksBadge").hidden=pending===0;
}
function renderPaymentConfig(){
  const c=state.paymentConfig;
  $("#collectorCard").innerHTML=c ? `
    <div class="collector-row"><span>Carteira</span><strong>${escapeHtml(c.collectorOperator)}</strong></div>
    <div class="collector-row"><span>Número</span><strong>${escapeHtml(c.collectorPhone)}</strong></div>
    <div class="collector-row"><span>Titular</span><strong>${escapeHtml(c.collectorName)}</strong></div>
    <div class="collector-row"><span>Estado</span><strong style="color:#facc15">Validação manual</strong></div>
  ` : '<span>Dados de pagamento indisponíveis.</span>';
}
function renderTransactions(items){
  const list=$("#txList");
  if(!items.length){
    list.innerHTML='<div class="empty">Sem movimentações recentes.</div>';
    return;
  }
  const names={deposit:"Depósito",withdrawal:"Levantamento",mission_reward:"Missão",referral_reward:"Afiliado"};
  const statuses={pending:"Pendente",approved:"Aprovado",rejected:"Rejeitado",completed:"Concluído"};
  list.innerHTML=items.map(t=>`
    <div class="tx-row">
      <div>
        <strong>${money(t.amount)}</strong> <span style="font-size:.67rem;color:#facc15">(${names[t.kind]||t.kind})</span>
        <span class="tx-meta">${escapeHtml(t.operator||"Vectra Watch")} • ${new Date(t.created_at).toLocaleString("pt-PT")}</span>
      </div>
      <span class="status status-${t.status}">${statuses[t.status]||t.status}</span>
    </div>
  `).join("");
  list.hidden=!state.historyOpen;
}
function toggleHistory(){
  state.historyOpen=!state.historyOpen;
  $("#txList").hidden=!state.historyOpen;
  $("#toggleHistoryBtn").textContent=state.historyOpen?"Recolher":"Expandir";
}

async function submitDeposit(ev){
  ev.preventDefault();
  const senderPhone=cleanPhone($("#depositPhone").value);
  const transactionCode=$("#depositCode").value.trim();
  if(!validPhone(senderPhone)) return showToast("Número do remetente inválido.");
  if(transactionCode.length<5) return showToast("Insira o código real da transação.");

  const btn=ev.submitter; btn.disabled=true;
  try{
    const data=await api("/api/deposits",{method:"POST",body:JSON.stringify({
      amount:state.selectedAmount,senderPhone,transactionCode
    })});
    $("#depositForm").reset();
    $("#depositOperator").textContent="";
    await loadTransactions();
    showToast(data.message || "Depósito enviado para validação.");
  }catch(e){ showToast(e.message); }
  finally{ btn.disabled=false; }
}

async function submitWithdrawal(ev){
  ev.preventDefault();
  const amount=Number($("#withdrawVal").value);
  const phone=cleanPhone($("#withdrawPhone").value);
  if(!Number.isFinite(amount)||amount<400) return showToast("O levantamento mínimo é 400 MT.");
  if(!validPhone(phone)) return showToast("Número da carteira inválido.");

  confirmDialog("Confirmar levantamento",`Bloquear ${money(amount)} para levantamento ao número +258 ${phone}?`,async()=>{
    const btn=ev.submitter; btn.disabled=true;
    try{
      await api("/api/withdrawals",{method:"POST",body:JSON.stringify({amount,phone})});
      $("#withdrawForm").reset();
      $("#withdrawOperator").textContent="";
      await refreshAll();
      showToast("Levantamento submetido. O valor está bloqueado até decisão.");
    }catch(e){ showToast(e.message); }
    finally{ btn.disabled=false; }
  });
}

async function openMission(mission){
  try{
    const run=await api(`/api/missions/${mission.id}/start`,{method:"POST"});
    state.currentMission=mission;
    state.currentRunId=run.runId;
    state.secondsRemaining=Number(run.minimumSeconds||10);
    state.playing=false;

    $("#videoModalTitle").textContent=mission.title;
    $("#videoModal").hidden=false;
    $("#btnClaimReward").disabled=true;
    $("#btnClaimReward").textContent="Aguarde a reprodução…";
    updateTimerText("Pressione Play para iniciar a validação.");

    initPlayer(mission.youtubeId);
    startTicker();
  }catch(e){ showToast(e.message); }
}

function initPlayer(videoId){
  if(!window.YT || !window.YT.Player){
    setTimeout(()=>{ if(!$("#videoModal").hidden) initPlayer(videoId); },300);
    return;
  }
  if(state.ytPlayer?.loadVideoById){
    state.ytPlayer.loadVideoById(videoId);
    return;
  }
  state.ytPlayer=new YT.Player("ytPlayerContainer",{
    videoId,
    width:"100%",
    height:"100%",
    playerVars:{playsinline:1,rel:0,modestbranding:1},
    events:{
      onStateChange:(event)=>{
        state.playing=event.data===YT.PlayerState.PLAYING;
        if(!state.playing && state.secondsRemaining>0) updateTimerText(`Pausado. Dê Play para continuar (${state.secondsRemaining}s).`,"danger");
      },
      onError:()=>updateTimerText("Não foi possível reproduzir este vídeo.","danger")
    }
  });
}
function startTicker(){
  clearInterval(state.ticker);
  state.ticker=setInterval(()=>{
    if(state.playing && state.secondsRemaining>0){
      state.secondsRemaining--;
      updateTimerText(`A monitorar: ${state.secondsRemaining}s restantes.`);
      if(state.secondsRemaining<=0){
        clearInterval(state.ticker);
        $("#btnClaimReward").disabled=false;
        $("#btnClaimReward").textContent="Concluir missão";
        updateTimerText("Tempo mínimo concluído. A validação final será feita no servidor.","success");
      }
    }
  },1000);
}
function updateTimerText(text,type=""){
  const box=$("#timerStatusBox");
  box.textContent=text;
  box.style.borderColor=type==="danger"?"#ef4444":type==="success"?"#10b981":"#374151";
  box.style.color=type==="danger"?"#fca5a5":type==="success"?"#6ee7b7":"#9ca3af";
}
async function claimMission(){
  if(!state.currentRunId) return;
  const btn=$("#btnClaimReward"); btn.disabled=true;
  try{
    const data=await api(`/api/missions/runs/${state.currentRunId}/claim`,{method:"POST"});
    closeVideoModal();
    await refreshAll();
    showToast(`Recompensa de ${money(data.reward)} creditada.`);
  }catch(e){
    btn.disabled=false;
    showToast(e.message);
  }
}
function closeVideoModal(){
  clearInterval(state.ticker);
  state.playing=false;
  try{ state.ytPlayer?.stopVideo?.(); }catch{}
  $("#videoModal").hidden=true;
  state.currentMission=null;
  state.currentRunId=null;
}

async function copyInvite(){
  if(!state.me) return;
  const url=`${location.origin}${location.pathname}?ref=${encodeURIComponent(state.me.user.refCode)}`;
  try{
    await navigator.clipboard.writeText(url);
    showToast("Link de convite copiado.");
  }catch{
    showToast(`Código: ${state.me.user.refCode}`);
  }
}
function signOut(toast=true){
  closeVideoModal();
  setSession("");
  state.me=null; state.missions=[];
  showAuth();
  setAuthMode("login");
  if(toast) showToast("Sessão terminada.");
}
function confirmDialog(title,text,onConfirm){
  $("#confirmTitle").textContent=title;
  $("#confirmText").textContent=text;
  $("#confirmModal").hidden=false;
  const ok=$("#confirmOk");
  const fresh=ok.cloneNode(true);
  ok.replaceWith(fresh);
  fresh.addEventListener("click",async()=>{
    $("#confirmModal").hidden=true;
    await onConfirm();
  },{once:true});
}
function escapeHtml(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}

bootstrap();
