/**
 * The Lockpicker — main.js
 * v1.3.0
 * - Full ApplicationV2 migration
 * - All gameplay parameters configurable via module settings
 * - GM History working
 */

const LOCKPICKING_NAMESPACE = "the-lockpicker";

const KEYS_ARROWS = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"];
const KEYS_WASD   = ["KeyW","KeyA","KeyS","KeyD"];
const KEYS_EXTRA  = ["KeyQ","KeyE","KeyR","KeyF","KeyG","KeyZ","KeyX","KeyC",
                     "Digit1","Digit2","Digit3","Digit4","Digit5"];

const KEY_LABELS = {
  ArrowUp:"↑",ArrowDown:"↓",ArrowLeft:"←",ArrowRight:"→",
  KeyW:"W",KeyA:"A",KeyS:"S",KeyD:"D",
  KeyQ:"Q",KeyE:"E",KeyR:"R",KeyF:"F",KeyG:"G",KeyZ:"Z",KeyX:"X",KeyC:"C",
  Digit1:"1",Digit2:"2",Digit3:"3",Digit4:"4",Digit5:"5"
};

const ARROW_ICON_PATHS = {
  ArrowUp:   "modules/the-lockpicker/icons/arrow-up.png",
  ArrowDown: "modules/the-lockpicker/icons/arrow-down.png",
  ArrowLeft: "modules/the-lockpicker/icons/arrow-left.png",
  ArrowRight:"modules/the-lockpicker/icons/arrow-right.png"
};
const PICK_ICON_PATHS = {
  ArrowUp:   "modules/the-lockpicker/icons/lockpick-up.png",
  ArrowDown: "modules/the-lockpicker/icons/lockpick-down.png",
  ArrowLeft: "modules/the-lockpicker/icons/lockpick-left.png",
  ArrowRight:"modules/the-lockpicker/icons/lockpick-right.png"
};
const SOUND_PATHS = {
  hit: "modules/the-lockpicker/sounds/click.mp3",
  miss:"modules/the-lockpicker/sounds/error.mp3",
  win: "modules/the-lockpicker/sounds/win.mp3",
  lose:"modules/the-lockpicker/sounds/fail.mp3"
};

/* ─── Settings helpers ─── */

function S(key) { return game.settings.get(LOCKPICKING_NAMESPACE, key); }

/* ─── Module Settings Registration ─── */

Hooks.once("init", () => {
  const R = (key, cfg) => game.settings.register(LOCKPICKING_NAMESPACE, key, cfg);
  const world = { scope:"world", config:true };
  const hidden = { scope:"world", config:false, type:String, default:"[]" };

  // Key pool thresholds
  R("dcWasd",  { ...world, name:"DC threshold — add WASD keys",          hint:"From this DC, WASD keys are added to the sequence pool (alongside arrows).", type:Number, default:15 });
  R("dcExtra", { ...world, name:"DC threshold — add Letters & Numbers",  hint:"From this DC, letter and number keys are also added.", type:Number, default:20 });

  // Sequence length
  R("stepsMultiplier", { ...world, name:"Steps per DC (multiplier)",     hint:"Sequence length = round(DC × this value). Default: 0.5", type:Number, default:0.5 });
  R("stepsMin",        { ...world, name:"Minimum sequence steps",         hint:"Shortest possible sequence regardless of DC. Default: 3", type:Number, default:3 });
  R("stepsMax",        { ...world, name:"Maximum sequence steps",         hint:"Longest possible sequence regardless of DC. Default: 15", type:Number, default:15 });

  // Time calculation
  R("timeBase",        { ...world, name:"Base time (seconds)",            hint:"Starting time at 5 steps. Each extra step adds proportional time. Default: 5", type:Number, default:5 });
  R("timeBonusMult",   { ...world, name:"Time bonus per skill point",     hint:"Seconds added per point of character bonus. Default: 0.5", type:Number, default:0.5 });
  R("timeTrapMult",    { ...world, name:"Trap time multiplier",           hint:"Time is multiplied by this for traps (harder). Default: 0.85", type:Number, default:0.85 });
  R("timeDisadvMult",  { ...world, name:"Disadvantage time multiplier",   hint:"Time is multiplied by this when the character has disadvantage. Default: 0.6", type:Number, default:0.6 });

  // Mistakes (Reliable Talent)
  R("mistakesDivisor", { ...world, name:"Reliable Talent mistakes divisor", hint:"Allowed mistakes = floor(training bonus ÷ this). Default: 2 (half the bonus)", type:Number, default:2 });
  R("extremeMemoTime",   { ...world, name:"Extreme Mode — memorization time (seconds)", hint:"How long the player sees the sequence before it disappears. Default: 3", type:Number, default:3 });
  R("defaultMistakes",   { ...world, name:"Default allowed mistakes (overrides Reliable Talent if > 0)", hint:"Set a fixed number of allowed mistakes for all players. 0 = use Reliable Talent calculation.", type:Number, default:0 });
  R("timeAdvMult",      { ...world, name:"Advantage time multiplier", hint:"Time is multiplied by this when the character has advantage. Default: 1.4 (40% more time)", type:Number, default:1.4 });

  // Hidden storage
  R("presets",   hidden);

  // Preload templates
  const loadTpl = foundry.applications?.handlebars?.loadTemplates ?? loadTemplates;
  loadTpl([
    "modules/the-lockpicker/templates/lock-config.hbs",
    "modules/the-lockpicker/templates/lock-game.hbs",
    "modules/the-lockpicker/templates/lock-history.hbs"
  ]);
});

/* ─── Helpers ─── */

function _getKeyPool(dc) {
  let pool = [...KEYS_ARROWS];
  if (dc >= S("dcWasd"))  pool = [...pool, ...KEYS_WASD];
  if (dc >= S("dcExtra")) pool = [...pool, ...KEYS_EXTRA];
  return pool;
}

function _estimateTime(dc, bonus, rollMode, challengeType) {
  const mult  = S("stepsMultiplier");
  const tBase = S("timeBase");
  const tBon  = S("timeBonusMult");
  const steps = Math.max(S("stepsMin"), Math.min(S("stepsMax"), Math.round(dc * mult)));
  let t = (tBase + (steps - 5) / 3) + (Math.max(0, bonus) * tBon);
  if (challengeType === "trap")        t *= S("timeTrapMult");
  if (rollMode === "disadvantage")     t *= S("timeDisadvMult");
  else if (rollMode === "advantage")   t *= S("timeAdvMult");
  return { steps, totalSeconds: Math.round(t * 10) / 10 };
}

async function _applyDamageDnd5e(actor, formula, damageType) {
  try {
    const roll = new Roll(formula);
    await roll.evaluate();
    const total = roll.total;

    // Show dice roll in chat
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `Trap damage (${damageType}): ${formula}`
    });

    // Apply HP directly — works on all dnd5e versions
    const currentHp = actor.system?.attributes?.hp?.value ?? 0;
    const newHp = Math.max(0, currentHp - total);
    await actor.update({ "system.attributes.hp.value": newHp });

    return { total, formula };
  } catch(e) {
    console.warn("the-lockpicker | damage apply failed", e);
    return null;
  }
}

/* ─── Registry ─── */

class LockpickingRegistry {
  static _map = {};
  static register(id, app)   { if (id) this._map[id] = app; }
  static unregister(id, app) { if (id && this._map[id] === app) delete this._map[id]; }
  static get(id)             { return this._map[id]; }
}

/* ─── Actor helpers ─── */

function actorHasReliableTalent(actor) {
  return actor.items.some(it => {
    if (!["feat","classFeature"].includes(it.type)) return false;
    const n = (it.name||"").toLowerCase();
    return n.includes("reliable talent") || n.includes("verlässlich");
  });
}

function getThievesToolsInfo(actor) {
  const gp = foundry.utils.getProperty;
  const dexMod    = Number(gp(actor,"system.abilities.dex.mod") ?? 0);
  const profBonus = Number(gp(actor,"system.attributes.prof")   ?? 0);
  let hasInv = false, hasEntry = false, prof = false, exp = false;
  let itemLvl = 0, toolLvl = 0;

  const invTool = actor.items.find(it => {
    const n = (it.name??"").toLowerCase();
    return it.type==="tool" && (n.includes("thieves")||n.includes("diebes"));
  });
  if (invTool) {
    hasInv = true;
    const pRaw = gp(invTool,"system.proficient");
    itemLvl = !Number.isNaN(Number(pRaw)) ? Number(pRaw) : (pRaw ? 1 : 0);
    if (itemLvl>=2) exp=true; else if (itemLvl>=1) prof=true;
  }

  const toolsData = gp(actor,"system.tools") ?? {};
  for (const [k,d] of Object.entries(toolsData)) {
    const ks = String(k).toLowerCase(), ls = String(d.label||"").toLowerCase();
    if (ks.includes("thief")||ks.includes("dieb")||ls.includes("thief")||ls.includes("diebes")) {
      hasEntry = true;
      let v = d.value ?? d.proficient ?? 0;
      if (typeof v !== "number") v = v ? 1 : 0;
      toolLvl = Math.max(toolLvl, v);
    }
  }
  if (toolLvl>=2) exp=true; else if (toolLvl>=1) prof=true;

  const lNone = "No Proficiency", lProf = "Proficiency", lExp = "Expertise";
  if (!hasInv && !hasEntry) return { dexMod, profBonus, hasToolInventory:false, hasToolsEntry:false,
    proficient:false, expert:false, totalBonus:0, disadvantage:true,
    bonusBreakdown:{ dexMod, profPart:0, profLabel:lNone, totalBonus:0 } };

  let total=dexMod, disadv=true, profPart=0, profLabel=lNone;
  if (exp)       { profPart=profBonus*2; profLabel=lExp;  total+=profPart; disadv=false; }
  else if (prof) { profPart=profBonus;   profLabel=lProf; total+=profPart; disadv=false; }

  return { dexMod, profBonus, hasToolInventory:hasInv, hasToolsEntry:hasEntry,
    proficient:prof, expert:exp, totalBonus:total, disadvantage:disadv,
    bonusBreakdown:{ dexMod, profPart, profLabel, totalBonus:total } };
}

/* ─── Sidebar button ─── */

Hooks.on("renderSceneControls", () => {
  if (!game.user.isGM) return;
  const aside = document.querySelector("#scene-controls");
  if (!aside || aside.querySelector(".lp-sidebar-btn")) return;
  const menu = aside.querySelector("menu#scene-controls-layers");
  if (!menu) return;
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control ui-control layer icon fa-solid fa-lock lp-sidebar-btn";
  btn.setAttribute("aria-label","The Lockpicker");
  btn.setAttribute("data-tooltip","The Lockpicker");
  btn.title = "The Lockpicker";
  btn.addEventListener("mousedown", ev => {
    if (ev.button!==0) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    new LockpickingConfigApp().render(true);
  });
  li.appendChild(btn);
  menu.appendChild(li);
});

/* ─── Button injection ─── */

function _resolveRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.get) return html.get(0);
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function _injectButton(actor, root) {
  if (!actor?.isOwner) return;
  const makeBtn = () => {
    const btn = document.createElement("a");
    btn.className = "lockpicking-trigger";
    btn.title = "Request Lockpicking / Trap Disarm";
    btn.innerHTML = `<i class="fas fa-lock"></i>`;
    btn.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
      ui.notifications.info("Request sent to Gamemaster...");
      game.socket.emit(`module.${LOCKPICKING_NAMESPACE}`, { action:"requestConfig", actorId:actor.id, userId:game.user.id });
    });
    return btn;
  };
  root.querySelectorAll("[data-item-id]").forEach(el => {
    const item = actor.items.get(el.dataset.itemId);
    if (!item || item.type!=="tool") return;
    const n = item.name.toLowerCase();
    if (!n.includes("thieves") && !n.includes("diebes")) return;
    if (el.querySelector(".lockpicking-trigger")) return;
    const btn = makeBtn();
    const ctrl = el.querySelector(".item-controls");
    if (ctrl) ctrl.prepend(btn);
    else { const nm=el.querySelector(".item-name"); if(nm) nm.appendChild(btn); else el.appendChild(btn); }
  });
  const sel = ["[data-key='thief']","[data-key='thieves-tools']","[data-key='thievesTools']",
    ".tool-row",".proficiency-row",".tools [data-trait]",".tools-list .entry",".tool-proficiencies li"].join(",");
  root.querySelectorAll(sel).forEach(el => {
    const k = (el.dataset.key||el.dataset.trait||"").toLowerCase();
    const t = el.textContent.toLowerCase();
    if (!(k.includes("thief")||k.includes("dieb")||k.includes("thieves")||t.includes("thieves")||t.includes("diebes"))) return;
    if (el.querySelector(".lockpicking-trigger")) return;
    const btn = makeBtn();
    const roll = el.querySelector("[data-action='roll'],.roll-button,button.rollable");
    const lbl  = el.querySelector(".tool-name,.skill-name-label,.label,.name");
    if (roll) { roll.parentNode.insertBefore(btn,roll); btn.style.marginRight="5px"; }
    else if (lbl) lbl.parentNode.insertBefore(btn, lbl.nextSibling);
    else el.appendChild(btn);
  });
}

Hooks.on("renderActorSheet",(app,html)=>{ const r=_resolveRoot(html); if(r) _injectButton(app.actor,r); });
for (const h of ["renderActorSheetV2","renderCharacterSheetV2","renderActorSheet5e2","renderNPCSheetV2"])
  Hooks.on(h,(app,html)=>{ const r=_resolveRoot(html); if(r) _injectButton(app.actor,r); });

/* ─── Ready ─── */

Hooks.once("ready", () => {
  console.log(`${LOCKPICKING_NAMESPACE} | Ready v1.3.0`);

  Hooks.on("createChatMessage", msg => {
    const d = msg.flags?.[LOCKPICKING_NAMESPACE];
    if (!d || d.action!=="openGame") return;
    const actor = game.actors.get(d.actorId);
    if (!actor) return;
    new LockpickingGameApp(actor, d, { spectator: game.user.id!==d.userId }).render(true);
  });

  game.socket.on(`module.${LOCKPICKING_NAMESPACE}`, payload => {
    if (!payload) return;
    if (payload.action==="requestConfig") {
      if (!game.user.isGM) return;
      const user  = game.users.get(payload.userId);
      const actor = game.actors.get(payload.actorId);
      ui.notifications.info(`${user?.name} wants to pick a lock or disarm a trap (${actor?.name}).`);
      new LockpickingConfigApp(payload.actorId).render(true);
      return;
    }
    if (payload.runId) {
      const app = LockpickingRegistry.get(payload.runId);
      if (app) app._onSocketEvent(payload);
    }
  });
});

/* ════════════════════════════════════════════════════════
   CONFIG APP  —  ApplicationV2
═══════════════════════════════════════════════════════════ */

class LockpickingConfigApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(preActorId=null, options={}) {
    super(options);
    this._preActorId = preActorId;
  }

  static DEFAULT_OPTIONS = {
    id: "lockpicking-config",
    window: { title:"The Lockpicker — Configuration", resizable:false },
    position: { width:500 },
    tag: "div"
  };


  static PARTS = {
    body: { template:"modules/the-lockpicker/templates/lock-config.hbs", scrollable:[""] }
  };

  async _prepareContext() {
    const groups = [];
    for (const user of game.users) {
      if (!user.active||user.isGM) continue;
      const chars = game.actors.filter(a=>a.type==="character"&&a.testUserPermission(user,"OWNER"));
      if (chars.length) groups.push({ userId:user.id, userName:user.name, options:chars.map(c=>({actorId:c.id,actorName:c.name})) });
    }
    let presetsRaw = [];
    try { presetsRaw = JSON.parse(S("presets")); } catch(e) {}
    const presets = presetsRaw.map(p=>({ name:p.name, dataJson:encodeURIComponent(JSON.stringify(p)) }));
    return { groups, defaultDc:15, presets, dcWasd:S("dcWasd"), dcExtra:S("dcExtra") };
  }

  _onRender(context, options) {
    const root = this.element;
    if (!root) return;

    // Centre window after Foundry sets position
    requestAnimationFrame(() => {
      const w = root.offsetWidth  || 500;
      const h = root.offsetHeight || 500;
      const left = Math.max(0, Math.round((window.innerWidth  - w) / 2));
      const top  = Math.max(0, Math.round((window.innerHeight - h) / 3));
      root.style.left = `${left}px`;
      root.style.top  = `${top}px`;
    });

    // Pre-select actor
    if (this._preActorId) {
      const actor = game.actors.get(this._preActorId);
      if (actor) {
        const owner = game.users.find(u=>!u.isGM&&u.active&&actor.testUserPermission(u,"OWNER"));
        if (owner) { const sel=root.querySelector("#lp-selection"); if(sel) sel.value=`${this._preActorId}|${owner.id}`; }
      }
    }

    const updateEstimate = () => {
      const selEl  = root.querySelector("#lp-selection");
      const dcEl   = root.querySelector("#lp-dc");
      const typeEl = root.querySelector("#lp-challenge-type");
      const estEl  = root.querySelector("#lp-time-estimate");
      if (!dcEl||!estEl) return;
      const dc   = Number(dcEl.value)||15;
      const type = typeEl?.value||"lock";
      const [actorId] = (selEl?.value||"").split("|");
      const actor = actorId ? game.actors.get(actorId) : null;
      const info  = actor ? getThievesToolsInfo(actor) : { totalBonus:0, disadvantage:false };
      const rollMode = root.querySelector("#lp-roll-mode")?.value || "normal";
      const { steps, totalSeconds } = _estimateTime(dc, info.totalBonus, rollMode, type);
      const pool = _getKeyPool(dc);
      const keys = pool.length>8 ? "Arrows + WASD + Letters/Numbers" : pool.length>4 ? "Arrows + WASD" : "Arrows only";
      estEl.textContent = `${steps} steps · ~${totalSeconds}s · ${keys}`;
    };

    // Toggle memorization time field when extreme mode changes
    const extremeCheck = root.querySelector("#lp-extreme-mode");
    extremeCheck?.addEventListener("change", () => {
      const show = extremeCheck.checked;
      root.querySelectorAll(".lp-extreme-only").forEach(el => el.style.display = show ? "" : "none");
    });

    const typeSelect = root.querySelector("#lp-challenge-type");
    typeSelect?.addEventListener("change", () => {
      const isTrap = typeSelect.value==="trap";
      root.querySelectorAll(".lp-trap-only").forEach(el=>el.style.display=isTrap?"":"none");
      root.querySelectorAll(".lp-chain-only").forEach(el=>el.style.display=isTrap?"":"none");
      updateEstimate();
    });

    const dcInput = root.querySelector("#lp-dc");
    dcInput?.addEventListener("input",  updateEstimate);
    dcInput?.addEventListener("change", updateEstimate);
    root.querySelector("#lp-selection")?.addEventListener("change", updateEstimate);
    root.querySelector("#lp-roll-mode")?.addEventListener("change", updateEstimate);

    // Preset load
    root.querySelector("#lp-preset-load")?.addEventListener("click", () => {
      const sel = root.querySelector("#lp-preset-select");
      if (!sel?.value) return;
      try {
        const p = JSON.parse(decodeURIComponent(sel.value));
        const t = root.querySelector("#lp-challenge-type");
        if (t) { t.value=p.challengeType||"lock"; t.dispatchEvent(new Event("change")); }
        const dc=root.querySelector("#lp-dc"); if(dc) dc.value=p.dc||15;
        const dmg=root.querySelector("#lp-damage"); if(dmg) dmg.value=p.damage||"2d6";
        const dt=root.querySelector("#lp-damage-type"); if(dt) dt.value=p.damageType||"piercing";
        updateEstimate();
      } catch(e) {}
    });

    // Preset delete
    root.querySelector("#lp-preset-delete")?.addEventListener("click", () => {
      const sel = root.querySelector("#lp-preset-select");
      if (!sel?.value) return ui.notifications.warn("Select a preset to delete.");
      try {
        const toDelete = JSON.parse(decodeURIComponent(sel.value));
        let list = JSON.parse(S("presets"));
        list = list.filter(p=>p.name!==toDelete.name);
        game.settings.set(LOCKPICKING_NAMESPACE,"presets",JSON.stringify(list));
        ui.notifications.info(`Preset "${toDelete.name}" deleted.`);
        this.render(true);
      } catch(e) { ui.notifications.error("Could not delete preset."); }
    });

    // Preset save
    root.querySelector("#lp-preset-save")?.addEventListener("click", () => {
      const nameEl = root.querySelector("#lp-preset-name");
      const name   = nameEl?.value?.trim()||`Preset ${Date.now()}`;
      const preset = {
        name,
        challengeType: root.querySelector("#lp-challenge-type")?.value||"lock",
        dc:            Number(root.querySelector("#lp-dc")?.value)||15,
        damage:        root.querySelector("#lp-damage")?.value||"2d6",
        damageType:    root.querySelector("#lp-damage-type")?.value||"piercing"
      };
      try {
        const list = JSON.parse(S("presets"));
        list.push(preset);
        game.settings.set(LOCKPICKING_NAMESPACE,"presets",JSON.stringify(list));
        ui.notifications.info(`Preset "${name}" saved.`);
        this.render(true);
      } catch(e) {}
    });


    // Submit
    root.querySelector("#lp-submit")?.addEventListener("click", ()=>this._submit(root));

    updateEstimate();
  }

  async _submit(root) {
    const selection     = root.querySelector("#lp-selection")?.value;
    const dc            = Number(root.querySelector("#lp-dc")?.value)||15;
    const challengeType = root.querySelector("#lp-challenge-type")?.value||"lock";
    const damage        = (root.querySelector("#lp-damage")?.value||"2d6").trim();
    const damageType    = root.querySelector("#lp-damage-type")?.value||"piercing";
    const extremeMode   = !!root.querySelector("#lp-extreme-mode")?.checked;
    const rollMode      = root.querySelector("#lp-roll-mode")?.value || "normal";

    if (!selection) return ui.notifications.error("No character selected.");
    const [actorId,userId] = selection.split("|");
    const actor = game.actors.get(actorId);
    if (!actor) return ui.notifications.error("Actor not found.");
    const info = getThievesToolsInfo(actor);
    if (!info.hasToolInventory&&!info.hasToolsEntry)
      return ui.notifications.error(`${actor.name} does not possess Thieves' Tools.`);

    const hasReliable     = actorHasReliableTalent(actor);
    const trainingBonus   = info.expert ? info.profBonus*2 : info.proficient ? info.profBonus : 0;
    const divisor = S("mistakesDivisor") || 2;
    const defaultMistakes = Number(S("defaultMistakes")) || 0;
    const gmMistakes = Number(root.querySelector("#lp-allowed-mistakes")?.value ?? -1);
    let allowedMistakes;
    if (gmMistakes >= 0) {
      allowedMistakes = gmMistakes; // GM set it manually in config
    } else if (defaultMistakes > 0) {
      allowedMistakes = defaultMistakes; // module setting override
    } else {
      allowedMistakes = hasReliable ? Math.floor(trainingBonus / divisor) : 0; // Reliable Talent calc
    }
    const runId           = foundry.utils.randomID();
    const isTrap          = challengeType==="trap";

    await ChatMessage.create({
      content: isTrap ? `Trap Disarming – <b>${actor.name}</b>…` : `Lockpicking – <b>${actor.name}</b>…`,
      speaker: { alias: isTrap ? "Trap Disarm" : "Lockpicking" },
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action:"openGame", runId, actorId, userId, dc, bonus:info.totalBonus,
          disadvantage:info.disadvantage, allowedMistakes,
          reliableTalent:hasReliable, bonusBreakdown:info.bonusBreakdown,
          reliableInfo:{ hasReliable, trainingBonus, allowedMistakes },
          challengeType, damage, damageType, extremeMode, rollMode,
          extremeMemoTime: extremeMode ? (Number(root.querySelector("#lp-extreme-memo-time")?.value) || S("extremeMemoTime") || 3) : 3
        }
      }
    });
    await this.close();
  }
}



/* ════════════════════════════════════════════════════════
   GAME APP  —  ApplicationV2
═══════════════════════════════════════════════════════════ */

class LockpickingGameApp extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  constructor(actor, config, opts={}) {
    super(opts);
    this.actor           = actor;
    this.config          = config;
    this.sequence        = [];
    this.currentIndex    = 0;
    this.totalTimeMs     = 0;
    this.remainingMs     = 0;
    this.allowedMistakes = config.allowedMistakes ?? 0;
    this.mistakesMade    = 0;
    this._lastTs         = null;
    this._raf            = null;
    this._keyHandler     = this._onKeyDown.bind(this);
    this._running        = false;
    this._spectator      = !!opts.spectator;
    this.runId           = config.runId;
    this._activeKeys     = [];
    this._memorizing    = false;
    this._extremeMode    = !!config.extremeMode;
    this._memoTime      = config.extremeMode ? (Number(config.extremeMemoTime) || S("extremeMemoTime") || 3) : 3;
    LockpickingRegistry.register(this.runId, this);
  }

  static DEFAULT_OPTIONS = {
    id: "lockpicking-game",
    window: { resizable:false },
    position: {
      width: 440,
      top: "auto",
      left: "auto"
    },
    tag: "div"
  };


  static PARTS = {
    body: { template:"modules/the-lockpicker/templates/lock-game.hbs", scrollable:[""] }
  };

  get title() {
    return this.config.challengeType==="trap" ? "Trap Disarming" : "Lockpicking";
  }

  async _prepareContext() {
    return {
      actorName:       this.actor.name,
      dc:              this.config.dc,
      bonus:           this.config.bonus,
      disadvantage:    this.config.rollMode === "disadvantage" || this.config.disadvantage,
      advantage:       this.config.rollMode === "advantage",
      rollMode:        this.config.rollMode || (this.config.disadvantage ? "disadvantage" : "normal"),
      allowedMistakes: this.allowedMistakes,
      reliableTalent:  this.config.reliableTalent,
      bonusBreakdown:  this.config.bonusBreakdown,
      reliableInfo:    this.config.reliableInfo,
      challengeType:   this.config.challengeType,
      isTrap:          this.config.challengeType==="trap",
      damage:          this.config.damage,
      damageType:      this.config.damageType,
      extremeMode:     this._extremeMode,
    };
  }

  _onRender(context, options) {
    const root = this.element;
    if (!root) return;

    // Centre window after Foundry sets position
    requestAnimationFrame(() => {
      const w = root.offsetWidth  || 440;
      const h = root.offsetHeight || 600;
      const left = Math.max(0, Math.round((window.innerWidth  - w) / 2));
      const top  = Math.max(0, Math.round((window.innerHeight - h) / 3));
      root.style.left = `${left}px`;
      root.style.top  = `${top}px`;
    });

    const q = s => root.querySelector(s);

    this._timerFill    = q(".lp-timer-fill");
    this._timerText    = q(".lp-timer-text");
    this._seq          = q(".lp-sequence-steps");
    this._keyIconBox   = q(".lp-current-key-icon");
    this._keyIconInner = q(".lp-current-key-icon-inner");
    this._keyPick      = q(".lp-current-key-pick");
    this._status       = q(".lp-status-text");
    this._mistakesInfo = q(".lp-mistakes-info");
    this._startBtn     = q("[data-action='start-game']");

    if (!this._spectator) {
      q("[data-action='start-game']")?.addEventListener("click",  this._start.bind(this));
      q("[data-action='cancel-game']")?.addEventListener("click", ()=>{ this._running=false; cancelAnimationFrame(this._raf); document.removeEventListener("keydown",this._keyHandler); this.close(); });
      if (!this._keyListenerActive) {
        document.addEventListener("keydown", this._keyHandler);
        this._keyListenerActive = true;
      }
    } else {
      if (this._startBtn) this._startBtn.disabled = true;
      q("[data-action='cancel-game']")?.addEventListener("click", ()=>this.close());
    }
    this._updateMistakesInfo();
  }

  async close(options={}) {
    cancelAnimationFrame(this._raf);
    document.removeEventListener("keydown", this._keyHandler);
    LockpickingRegistry.unregister(this.runId, this);
    return super.close(options);
  }

  _playSound(type) {
    const src = SOUND_PATHS[type];
    if (src) foundry.audio.AudioHelper.play({ src, volume:0.5, autoplay:true, loop:false }, false);
  }

  _generateSequence(len) {
    const pool = _getKeyPool(this.config.dc);
    this._activeKeys = pool;
    return Array.from({ length:len }, ()=>pool[Math.floor(Math.random()*pool.length)]);
  }

  _setupDifficulty() {
    const { dc, bonus, rollMode, challengeType } = this.config;
    const { steps, totalSeconds } = _estimateTime(dc, bonus, rollMode || (this.config.disadvantage ? "disadvantage" : "normal"), challengeType);
    this.sequence    = this._generateSequence(steps);
    this.totalTimeMs = totalSeconds * 1000;
    this.remainingMs = this.totalTimeMs;
  }

  _emitSocket(action, extra={}) {
    if (this._spectator||!this.runId) return;
    game.socket.emit(`module.${LOCKPICKING_NAMESPACE}`, {
      action, runId:this.runId,
      actorId:this.actor.id, userId:this.config.userId,
      dc:this.config.dc, bonus:this.config.bonus,
      disadvantage:this.config.disadvantage,
      allowedMistakes:this.allowedMistakes,
      challengeType:this.config.challengeType,
      ...extra
    });
  }

  _onSocketEvent(p) {
    if (!this._spectator||p.runId!==this.runId) return;
    switch(p.action) {
      case "start":   this._onSocketStart(p);   break;
      case "step":    this._onSocketStep(p);    break;
      case "mistake": this._onSocketMistake(p); break;
      case "finish":  this._onSocketFinish(p);  break;
    }
  }

  _onSocketStart(p) {
    this.sequence=p.sequence; this.totalTimeMs=p.totalTimeMs; this.remainingMs=p.totalTimeMs;
    this.mistakesMade=0; this.currentIndex=0;
    this._renderSequence(); this._updateMistakesInfo();
    if (this.sequence.length) { this._updateCurrentKeyIcon(); this._highlightCurrentStep(); }
    if (this._status) this._status.textContent="Minigame started (Spectator).";
    this._lastTs=null; this._running=true;
    if (this._startBtn) this._startBtn.disabled=true;
    this._raf=requestAnimationFrame(this._tick.bind(this));
  }

  _onSocketStep(p) {
    this._playSound("hit");
    const el=this._seq?.querySelector(`[data-index="${p.index}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending");
      el.classList.add("lp-sequence-step--success");
      const ic=el.querySelector(".lp-sequence-step-icon");
      if (ic) ic.textContent=KEY_LABELS[p.key]||p.key;
    }
    this.currentIndex=p.index+1;
    if (this.currentIndex>=this.sequence.length) {
      if (this._keyIconInner) { this._keyIconInner.style.backgroundImage=""; this._keyIconInner.textContent=""; }
      if (this._keyPick) this._keyPick.style.opacity="0";
    } else { this._updateCurrentKeyIcon(); this._highlightCurrentStep(); }
    this._flashCurrentKeyIcon();
  }

  _onSocketMistake(p) {
    this._playSound("miss"); this.mistakesMade=p.mistakesMade;
    this._updateMistakesInfo();
    if (this._status) this._status.textContent=`Wrong Key (${this.mistakesMade}/${this.allowedMistakes})`;
    this._flashErrorKeyIcon();
  }

  _onSocketFinish(p) {
    if (p.success) this._playSound("win"); else this._playSound("lose");
    if (this._status) this._status.textContent = p.success ? "Success! (Spectator)" : `Failure: ${p.reason} (Spectator)`;
    cancelAnimationFrame(this._raf); this._running=false;
    if (this._startBtn) this._startBtn.disabled=false;
    setTimeout(()=>this.close(),1500);
  }

  _highlightCurrentStep() {
    if (!this._seq) return;
    this._seq.querySelectorAll(".lp-sequence-step--current").forEach(el=>el.classList.remove("lp-sequence-step--current"));
    this._seq.querySelector(`[data-index="${this.currentIndex}"]`)?.classList.add("lp-sequence-step--current");
  }

  _updatePickForKey(k) {
    if (!this._keyPick) return;
    if (!k) { this._keyPick.style.opacity="0"; return; }
    if (PICK_ICON_PATHS[k]) { this._keyPick.style.backgroundImage=`url("${PICK_ICON_PATHS[k]}")`; this._keyPick.style.opacity="1"; }
    else this._keyPick.style.opacity="0";
  }

  _flashCurrentKeyIcon() {
    if (!this._keyIconBox) return;
    this._keyIconBox.classList.remove("lp-current-key-icon--hit","lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--hit");
  }

  _flashErrorKeyIcon() {
    if (!this._keyIconBox) return;
    this._keyIconBox.classList.remove("lp-current-key-icon--hit","lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--error");
  }

  _start() {
    if (this._spectator||this._running) return;
    this._running=true;
    if (this._startBtn) this._startBtn.disabled=true;
    this._setupDifficulty();
    this._renderSequence();
    this.currentIndex=0; this.mistakesMade=0;
    this._updateMistakesInfo();

    const go = () => {
      if (this.sequence.length) { this._updateCurrentKeyIcon(); this._highlightCurrentStep(); }
      // Hide status text when game starts
      const statusEl = this.element?.querySelector(".lp-status-text");
      if (statusEl) statusEl.style.display = "none";
      if (this._status) this._status.style.display = "none";
      this._lastTs=null;
      this._emitSocket("start",{ sequence:this.sequence, totalTimeMs:this.totalTimeMs, mistakesMade:0 });
      this._raf=requestAnimationFrame(this._tick.bind(this));
    };

    if (this._extremeMode) {
      // Show sequence for memoTime seconds with countdown, then hide and start
      let remaining = Math.max(1, Math.round(this._memoTime));
      this._memorizing = true;

      const setStatus = (text) => {
        const el = this.element?.querySelector(".lp-status-text");
        if (el) { el.style.display = ""; el.textContent = text; }
        if (this._status) { this._status.style.display = ""; this._status.textContent = text; }
      };

      setStatus(`Memorize! ${remaining}s`);

      const countdown = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          setStatus(`Memorize! ${remaining}s`);
        } else {
          clearInterval(countdown);
          this._memorizing = false;
          this.element?.querySelectorAll(".lp-sequence-step").forEach(el => el.classList.add("lp-sequence-step--hidden"));
          this._seq?.querySelectorAll(".lp-sequence-step").forEach(el => el.classList.add("lp-sequence-step--hidden"));
          go();
        }
      }, 1000);
    } else {
      go();
    }
  }

  _renderSequence() {
    if (!this._seq) return;
    this._seq.innerHTML="";
    this.sequence.forEach((k,i)=>{
      const d=document.createElement("div");
      d.className="lp-sequence-step lp-sequence-step--pending";
      d.dataset.index=i;
      const ic=document.createElement("div");
      ic.className="lp-sequence-step-icon";
      if (ARROW_ICON_PATHS[k]) ic.style.backgroundImage=`url("${ARROW_ICON_PATHS[k]}")`;
      else { ic.textContent=KEY_LABELS[k]||k; ic.classList.add("lp-sequence-step-icon--text"); }
      d.appendChild(ic); this._seq.appendChild(d);
    });
  }

  _updateCurrentKeyIcon() {
    if (!this.sequence.length||this.currentIndex>=this.sequence.length) {
      if (this._keyIconInner) { this._keyIconInner.style.backgroundImage=""; this._keyIconInner.textContent=""; }
      this._updatePickForKey(null); return;
    }
    const k=this.sequence[this.currentIndex];
    if (this._keyIconInner) {
      if (ARROW_ICON_PATHS[k]) { this._keyIconInner.style.backgroundImage=`url("${ARROW_ICON_PATHS[k]}")`; this._keyIconInner.textContent=""; }
      else { this._keyIconInner.style.backgroundImage=""; this._keyIconInner.textContent=KEY_LABELS[k]||k; this._keyIconInner.classList.add("lp-key-label"); }
    }
    this._updatePickForKey(k);
  }

  _updateMistakesInfo() {
    if (!this._mistakesInfo) return;
    if (this.allowedMistakes===0) { this._mistakesInfo.textContent=""; return; }
    this._mistakesInfo.textContent=`Mistakes allowed: ${this.allowedMistakes-this.mistakesMade}/${this.allowedMistakes}`;
  }

  _tick(ts) {
    if (this._lastTs===null) this._lastTs=ts;
    else { this.remainingMs=Math.max(0,this.remainingMs-(ts-this._lastTs)); this._lastTs=ts; }
    const ratio=this.totalTimeMs>0?(this.remainingMs/this.totalTimeMs):0;
    const r=Math.round(76+(244-76)*(1-ratio)), g=Math.round(175+(67-175)*(1-ratio)), b=Math.round(80+(54-80)*(1-ratio));
    if (this._timerFill) { this._timerFill.style.backgroundColor=`rgb(${r},${g},${b})`; this._timerFill.style.width=`${ratio*100}%`; }
    if (this._timerText) this._timerText.textContent=`${(this.remainingMs/1000).toFixed(1)}s`;
    if (this.remainingMs<=0) {
      if (!this._spectator) { this._playSound("lose"); return this._finish(false,"Time's up"); }
      cancelAnimationFrame(this._raf); return;
    }
    this._raf=requestAnimationFrame(this._tick.bind(this));
  }

  _onKeyDown(ev) {
    if (this._spectator||!this._running||this._memorizing) return;
    const matched=this._activeKeys.find(k=>k===ev.key||k===ev.code);
    if (!matched) return;
    ev.preventDefault(); ev.stopPropagation();
    if (!this.sequence.length||this.currentIndex>=this.sequence.length) return;
    const exp=this.sequence[this.currentIndex];

    if (matched!==exp) {
      this._playSound("miss"); this._flashErrorKeyIcon();
      if (this.mistakesMade<this.allowedMistakes) {
        this.mistakesMade++; this._updateMistakesInfo();
        if (this._status) this._status.textContent=`Wrong Key (${this.mistakesMade}/${this.allowedMistakes})`;
        this._emitSocket("mistake",{ mistakesMade:this.mistakesMade });
        return;
      }
      this._emitSocket("mistake",{ mistakesMade:this.mistakesMade+1 });
      return this._finish(false,"Wrong Key");
    }

    this._playSound("hit"); this._updatePickForKey(exp); this._flashCurrentKeyIcon();
    const el=this._seq?.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending","lp-sequence-step--hidden");
      el.classList.add("lp-sequence-step--success");
      const ic=el.querySelector(".lp-sequence-step-icon");
      if (ic) { if(ARROW_ICON_PATHS[exp]) ic.style.backgroundImage=`url("${ARROW_ICON_PATHS[exp]}")`; else ic.textContent=KEY_LABELS[exp]||exp; }
    }
    this._emitSocket("step",{ index:this.currentIndex, key:exp });
    this.currentIndex++;
    if (this.currentIndex>=this.sequence.length) return this._finish(true,"");
    this._updateCurrentKeyIcon(); this._highlightCurrentStep();
  }

  async _finish(success, reason) {
    if (success) this._playSound("win"); else this._playSound("lose");
    const _showStatus = (text) => {
      const el = this.element?.querySelector(".lp-status-text");
      if (el) { el.style.display = ""; el.textContent = text; }
      if (this._status) { this._status.style.display = ""; this._status.textContent = text; }
    };
    _showStatus(success ? "✅ Success!" : `❌ Failure: ${reason}`);
    cancelAnimationFrame(this._raf); this._running=false;
    if (this._startBtn) this._startBtn.disabled=false;
    this._emitSocket("finish",{ success, reason, mistakesMade:this.mistakesMade });
    this._updatePickForKey(null);

    const isTrap  = this.config.challengeType==="trap";
    const result  = success ? "Success" : "Failure";
    let content   = "";
    let dmgResult = null;

    if (isTrap) {
      content += `Trap Disarming – <b>${this.actor.name}</b>`;
      content += `<br>Result: <b>${result}</b>`;
      if (!success) {
        if (game.user.isGM) dmgResult = await _applyDamageDnd5e(this.actor, this.config.damage, this.config.damageType);
        content += "<br><hr>";
        if (dmgResult) {
          content += `⚠ <b>Trap triggered! ${dmgResult.total} ${this.config.damageType} damage applied (${dmgResult.formula}).</b>`;
        } else {
          content += `⚠ <b>Trap triggered!</b> GM should apply <b>${this.config.damage} ${this.config.damageType}</b> damage.<br><em>GM: apply damage manually.</em>`;
        }
      }
    } else {
      content += `Lockpicking – <b>${this.actor.name}</b><br>Result: <b>${result}</b>`;
    }

    await ChatMessage.create({ speaker:ChatMessage.getSpeaker({ actor:this.actor }), content });



    setTimeout(()=>this.close(), 1500);
  }
}
