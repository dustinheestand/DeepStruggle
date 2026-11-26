/**
 * The phone page (play.html): a game against a friend -- or both sides on one device, for
 * practice -- shown in summaries rather than on the map.
 *
 * - The top strip: turn and round, DEFCON, VP, Military Ops, the Space Race, the China Card, and
 *   the connection and whose move it is.
 * - Board: one tile per region -- each side's battlegrounds and countries ("bg-total", blue for
 *   the US, red for the USSR), the standing, what a scoring would give now, where its scoring card
 *   is, the targets the open decision offers there -- and "what happened" since your last move.
 *   A tap opens that region's countries as a list, where the targets are chosen.
 * - Hand: your cards (a tap shows the text), the other hand's size, the deck and the discards.
 * - History: every play, newest first, each with its upshot in short -- "Asia 2-5/2-5 → 3-6/2-5",
 *   the countries it changed, VP and DEFCON -- and its full lines on a tap.
 * - The decision: the workbench's own HUD (action_hud.ts), so every decision the engine has is
 *   offered, and the hand when a card is to be played.
 *
 * Take-backs: online, your steps stay on this phone until you send them -- you may take them back
 * until then -- except that a step that rolls a die or shows you a card you had not seen (a draw, a
 * peek, the other hand) is sent at once and cannot be taken back. When the decision passes to your
 * friend, Send hands it over.
 */
import "./play.css";
import { WasmEngine } from "../engine/wasm_engine";
import { GameSession } from "../game/session";
import { GameState, MicroAction, RegionScores, RegionalStatus } from "../types";
import { ActionHud } from "../action_hud";
import { redactState } from "../game/view";
import { lastTurnOf } from "../game/last_turn";
import { OnlineGame, createRoom, pushKey, roomSocketUrl, seatLink, subscribeSeat, webSocketConnect } from "../game/online";
import { Seat, otherSeat } from "../game/online_protocol";
import { applyWireSteps, sessionSteps, startOnlineGame } from "../game/online_session";
import { PLAY_ENDPOINT } from "../build_info";
import { CARDS_METADATA, MAP_METADATA } from "../metadata";
import { escapeHtml } from "../html";
import { lineHtml, messageHtml } from "../game/log";
import { groupLog } from "../game/log_view";
import { effectNameMessage } from "../cards_view";
import { spaceRaceBoxes } from "../tracks_view";
import { cardDescription, cardName, countryName, initLanguage, regionName, renderEnglish, sideName, t } from "../i18n";
import {
  Count, HistoryEntry, countriesById, REGIONS, SCORING_CARDS, SE_ASIA, Upshot, cardWhere, countText, history, regionCountries,
  regionCounts, revealed, spaceAbilities,
} from "./summary";

type Tab = "board" | "hand" | "history";

const CARD = new Map(CARDS_METADATA.map(c => [c.id, c]));
const COUNTRY = new Map(MAP_METADATA.countries.map(c => [c.id, c]));

const sideCls = (s: string) => (s === "US" ? "us" : s === "USSR" ? "ussr" : "");

function deciderOf(s: GameState): Seat | null {
  const p = s.decision_context?.decision_player;
  return p === "US" || p === "USSR" ? p : null;
}

const GAMES_KEY = "ts.play.games";

interface SavedSeat {
  room: string;
  side: Seat;
  url: string;
  at: string;
}

function loadGames(): SavedSeat[] {
  try {
    const v = JSON.parse(localStorage.getItem(GAMES_KEY) || "[]");
    return Array.isArray(v) ? v.filter(g => g && typeof g.url === "string" && (g.side === "US" || g.side === "USSR")) : [];
  } catch {
    return [];
  }
}

/** A VAPID key (base64url) as PushManager.subscribe takes it. */
function urlB64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const t64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t64 + "=".repeat((4 - (t64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class PlayApp {
  private engine!: WasmEngine;
  private session!: GameSession;
  private hud = new ActionHud(a => this.act(a));
  private online: OnlineGame | null = null;
  private practice = false;
  private room = "";
  private seat = "";
  private invite = "";
  private invited = false;
  /** Steps sent, or that must be: the ones before it cannot be taken back. */
  private committed = 0;
  private tab: Tab = "board";
  private region: string | null = null;
  private expanded = new Set<number>();
  private full: GameState | null = null;
  private shown: GameState | null = null;
  private scores: RegionScores | null = null;
  private viewSide: Seat = "US";
  private wasMine = false;
  /** The online game started or played steps since the board was drawn. */
  private boardDirty = true;
  private collapsed = false;
  private baseTitle = document.title;

  async boot() {
    const p = new URLSearchParams(location.search);
    this.room = p.get("room") || "";
    this.seat = p.get("seat") || "";
    this.invite = p.get("invite") || "";
    this.hud.online = true;   // no die to force here, and the hidden side is a person
    this.hud.influenceHtml = (us, ussr) => `<span class="hud-inf"><span class="us">${us}</span>/<span class="ussr">${ussr}</span></span>`;
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
        .catch(e => console.warn("service worker:", e));
    }
    this.bindChrome();
    // Until the game is on the board, say what it waits for: the engine (a few MB), then the relay.
    this.main().innerHTML = `<p class="play-wait">${t("app:play.loadingEngine")}</p>`;
    try {
      this.engine = await WasmEngine.load();
    } catch (e) {
      this.main().innerHTML = `<p class="play-error">${escapeHtml(String(e))}</p>`;
      return;
    }
    this.session = new GameSession(this.engine);
    if (this.room) this.startOnline();
    else this.renderStart();
  }

  private main(): HTMLElement {
    return document.getElementById("play-main")!;
  }

  // ---- starting --------------------------------------------------------------------------------

  private renderStart() {
    document.body.classList.add("play-starting");
    const online = PLAY_ENDPOINT
      ? `<h2>${t("app:play.friendTitle")}</h2>
         <p class="play-dim">${t("app:play.friendText")}</p>
         <div class="play-row">
           <button class="btn btn-primary btn-big" data-start="US">${t("app:play.asUs")}</button>
           <button class="btn btn-danger btn-big" data-start="USSR">${t("app:play.asUssr")}</button>
         </div>`
      : `<p class="play-dim">${t("app:play.noRelay")}</p>`;
    this.main().innerHTML = `<div class="play-start">
      <h1>Twilight Struggle</h1>
      ${online}
      ${this.gamesHtml()}
      <h2>${t("app:play.practiceTitle")}</h2>
      <p class="play-dim">${t("app:play.practiceText")}</p>
      <button class="btn btn-secondary btn-big" data-start="practice">${t("app:play.practice")}</button>
      <p class="play-legend"><a class="play-dim" href="./?workbench">${t("app:play.workbench")}</a></p>
    </div>`;
    this.main().querySelector<HTMLFormElement>("[data-paste]")?.addEventListener("submit", e => {
      e.preventDefault();
      const raw = String(new FormData(e.target as HTMLFormElement).get("link") || "").trim();
      try {
        const u = new URL(raw);
        const room = u.searchParams.get("room"), seat = u.searchParams.get("seat");
        if (!room || !seat) throw new Error("no room");
        location.assign(seatLink(location.href, room, seat, u.searchParams.get("invite") ?? undefined));
      } catch {
        this.toast(t("app:play.badLink"));
      }
    });
    this.main().querySelectorAll<HTMLButtonElement>("[data-start]").forEach(b => b.addEventListener("click", async () => {
      const what = b.dataset.start!;
      if (what === "practice") {
        document.body.classList.remove("play-starting");
        this.practice = true;
        startOnlineGame(this.session, Math.floor(Math.random() * 1_000_000));
        this.update();
        return;
      }
      b.disabled = true;
      try {
        const r = await createRoom(PLAY_ENDPOINT, this.engine.fingerprint);
        const side = what as Seat;
        location.assign(seatLink(location.href, r.room, r.seats[side], r.seats[otherSeat(side)]));
      } catch (e) {
        b.disabled = false;
        this.toast(t("app:online.createFailed", { error: e instanceof Error ? e.message : String(e) }));
      }
    }));
  }

  /** The games this browser has a seat in, and a box to paste a game link into (a phone's installed
   *  app keeps storage apart from its browser, so a link from a message lands in the browser). */
  private gamesHtml(): string {
    const games = loadGames();
    const rows = games.map(g => `<a class="game-link" href="${escapeHtml(g.url)}">
        <span class="${sideCls(g.side)}">${sideName(g.side)}</span>
        <span class="play-dim">${escapeHtml(new Date(g.at).toLocaleDateString())}</span></a>`).join("");
    return `<h2>${t("app:play.yourGames")}</h2>
      ${rows ? `<div class="game-list">${rows}</div>` : `<p class="play-dim">${t("app:play.noGames")}</p>`}
      <form class="paste-link" data-paste>
        <input name="link" type="url" placeholder="${escapeHtml(t("app:play.pastePlaceholder"))}" autocomplete="off">
        <button class="btn btn-secondary">${t("app:play.open")}</button>
      </form>`;
  }

  private startOnline() {
    if (!PLAY_ENDPOINT) {
      this.main().innerHTML = `<p class="play-error">${t("app:online.noRelay")}</p>`;
      return;
    }
    const s = this.session;
    this.online = new OnlineGame(webSocketConnect(roomSocketUrl(PLAY_ENDPOINT, this.room, this.seat)), {
      steps: () => sessionSteps(s),
      start: (seed, _side, roomEngine) => {
        startOnlineGame(s, seed);
        this.boardDirty = true;
        this.committed = 0;
        queueMicrotask(() => this.rememberGame());
        if (roomEngine && roomEngine !== this.engine.fingerprint) {
          this.toast(t("app:online.otherEngine", { room: roomEngine.slice(0, 8), page: this.engine.fingerprint.slice(0, 8) }), 8000);
        }
      },
      apply: (steps) => {
        const why = applyWireSteps(s, steps);
        this.boardDirty = true;
        if (!why) this.committed = s.steps.length;
        return why;
      },
      // Presence and the connection redraw the status line only: a redraw of the board under a
      // finger would swallow the tap.
      changed: () => {
        if (this.full && !this.boardDirty) this.renderStatus();
        else this.update(false);
      },
      pushable: () => this.committed,
      next: () => this.nextToMove(),
      activity: () => {
        this.activeUntil = Date.now() + 3500;
        this.renderStatus();
        setTimeout(() => this.renderStatus(), 3600);
      },
    });
    this.renderStatus();
    this.main().innerHTML = `<p class="play-wait">${t("app:play.connecting")}</p>`;
    this.online.start();
    const wake = () => {
      const visible = document.visibilityState === "visible";
      this.online?.setVisible(visible);
      if (visible) this.online?.wake(true);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", e => { if (e.persisted) wake(); });
    // Any tap is a sign of life for the other player (no more than that is sent).
    document.addEventListener("pointerdown", () => this.online?.activity(), { passive: true });
  }

  /** Who moves after what is being sent, and this side's last play as the other side may read it. */
  private nextToMove(): { side: Seat; note: string } | null {
    const me = this.me;
    if (!me) return null;
    const full = this.session.state();
    const d = deciderOf(full);
    if (!d || d === me) return null;
    const entries = groupLog(redactState(full, d).action_logs || []);
    const mine = [...entries].reverse().find(e => e.player === me);
    return { side: d, note: mine ? renderEnglish(mine.title) : "" };
  }

  /** Until when the other player's last tap shows. */
  private activeUntil = 0;

  // ---- notifications ----------------------------------------------------------------------------

  private get notifyKey(): string {
    return `ts.play.notify.${this.room}`;
  }

  private notifyState(): "on" | "ask" | "install" | "blocked" | "none" {
    if (!this.online || !this.me) return "none";
    try {
      if (localStorage.getItem(this.notifyKey)) return "on";
    } catch { /* no storage */ }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true ||
      matchMedia("(display-mode: standalone)").matches;
    if (!("PushManager" in window) || !("serviceWorker" in navigator)) return ios && !standalone ? "install" : "none";
    if (typeof Notification !== "undefined" && Notification.permission === "denied") return "blocked";
    return "ask";
  }

  private async enableNotifications() {
    const state = this.notifyState();
    if (state === "install") {
      this.sheet(`<h2>${t("app:play.notifyTitle")}</h2><p>${t("app:play.notifyInstall")}</p>`);
      return;
    }
    if (state === "blocked") return this.notifyBlocked();
    if (state !== "ask") return;
    try {
      const answer = await Notification.requestPermission();
      // Denied -- or never asked (Chrome blocks a prompt it judges unwanted, quietly): only the
      // device's settings can change it now, so say where.
      if (answer !== "granted") return this.notifyBlocked();
      const key = await pushKey(PLAY_ENDPOINT);
      if (!key) throw new Error(t("app:play.notifyNoRelay"));
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ??
        await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await subscribeSeat(PLAY_ENDPOINT, this.room, this.seat, { subscription: json, url: location.href });
      try { localStorage.setItem(this.notifyKey, json.endpoint); } catch { /* no storage */ }
      this.toast(t("app:play.notifyOn"));
    } catch (e) {
      this.toast(t("app:play.notifyFailed", { error: e instanceof Error ? e.message : String(e) }), 6000);
    }
    this.renderStatus();
  }

  /** Notifications are off for this site: where this device turns them back on. */
  private notifyBlocked() {
    const ua = navigator.userAgent;
    const how = /iPhone|iPad|iPod/.test(ua) ? t("app:play.unblock.ios")
      : /Android/.test(ua) ? t("app:play.unblock.android") : t("app:play.unblock.desktop");
    this.sheet(`<h2>${t("app:play.notifyTitle")}</h2><p>${t("app:play.notifyBlocked")}</p><p>${how}</p>`);
    this.renderStatus();
  }

  // ---- your games -------------------------------------------------------------------------------

  private rememberGame() {
    if (!this.me) return;
    try {
      const list = loadGames().filter(g => g.room !== this.room);
      list.unshift({ room: this.room, side: this.me, url: location.href, at: new Date().toISOString() });
      localStorage.setItem(GAMES_KEY, JSON.stringify(list.slice(0, 20)));
    } catch { /* no storage */ }
  }

  // ---- moving ---------------------------------------------------------------------------------

  private get me(): Seat | null {
    return this.online?.side ?? null;
  }

  private canMove(): boolean {
    if (this.practice) return true;
    const g = this.online;
    if (!g || g.seed === null || g.status === "desync" || !this.full) return false;
    return deciderOf(this.full) === g.side;
  }

  /**
   * One step of yours: a HUD button, a country, a card. Online, a step that would roll a die or show
   * you a card you have not seen -- which can then not be taken back -- is tried first, taken back
   * unseen, and played only once you confirm it: so a slip on the last point of a turn (which deals
   * the next hand) or a mistapped coup is caught before anything is revealed.
   */
  private act(action: MicroAction) {
    if (!this.canMove() || !this.full) return;
    const a: MicroAction = { ...action, secondary_id: action.secondary_id ?? 0 };
    const how = { source: "human" as const, analysis: false };
    const side = this.viewSide;
    const before = redactState(this.full, side).card_locations;
    const why = this.session.apply(a, 0, how);
    if (why) {
      this.toast(why);
      return;
    }
    if (this.online) {
      const tag = this.session.tags[this.session.tags.length - 1];
      const shows = revealed(before, redactState(this.session.state(), side).card_locations);
      if (tag?.rolled || shows) {
        this.session.undo(false);   // nothing of it was drawn
        const what = tag?.rolled ? t("app:play.revealsDie") : t("app:play.revealsCards");
        if (!window.confirm(t("app:play.confirmReveal", { what, step: this.stepWords(a) }))) {
          this.update(false);
          return;
        }
        const again = this.session.apply(a, 0, how);
        if (again) {
          this.toast(again);
          return;
        }
        this.committed = this.session.steps.length;
      }
    }
    this.update();
  }

  /** A step in a few words, for its confirmation. */
  private stepWords(a: MicroAction): string {
    const L = this.engine.layout;
    const ctx = this.full!.decision_context;
    if (a.decision_type === L.decision_types.POINT_NODE && a.primary_id < 84) {
      const name = countryName(a.primary_id, COUNTRY.get(a.primary_id)?.name ?? String(a.primary_id));
      const verb = ctx.op_mode === L.op_modes.COUP ? t("app:play.coup") : ctx.op_mode === L.op_modes.REALIGN ? t("app:play.realign") : "";
      return verb ? `${verb}: ${name}` : name;
    }
    if (a.decision_type === L.decision_types.SELECT_CARD && CARD.has(a.primary_id)) {
      return cardName(a.primary_id, CARD.get(a.primary_id)!.name);
    }
    return t("app:play.thisStep");
  }

  private pending(): number {
    return this.practice ? 0 : this.session.steps.length - this.committed;
  }

  private undo() {
    if (this.practice ? this.session.canUndo : this.pending() > 0) {
      this.session.undo(false);
      this.update();
    }
  }

  private send() {
    this.committed = this.session.steps.length;
    this.update();
  }

  // ---- drawing --------------------------------------------------------------------------------

  /** The position changed (or only the connection): redraw, and send what may be sent. */
  private update(push = true) {
    if (!this.session || (this.online && this.online.seed === null)) {
      this.renderStatus();
      return;
    }
    const full = this.session.state();
    this.full = full;
    this.boardDirty = false;
    if (this.me) this.viewSide = this.me;
    else this.viewSide = deciderOf(full) ?? this.viewSide;
    const shown = redactState(full, this.viewSide);
    shown.last_turn = lastTurnOf(this.session.start, this.session.steps, otherSeat(this.viewSide));
    this.shown = shown;
    try {
      this.scores = this.engine.regionScores(full);
    } catch {
      this.scores = null;
    }
    const mine = this.canMove();
    // Your decision, placing on the map: the board is where it is made.
    if (mine && !this.wasMine && this.isPointDecision()) this.tab = "board";
    if (mine && !this.wasMine && this.online && this.session.steps.length > 0) navigator.vibrate?.(60);
    this.wasMine = mine;
    this.renderTracks();
    this.renderStatus();
    this.renderTabs();
    this.renderMain();
    this.renderDecision();
    if (push) this.online?.push();
    this.maybeInvite();
  }

  private isPointDecision(): boolean {
    const s = this.shown;
    return !!s && s.decision_context.decision_type === this.engine.layout.decision_types.POINT_NODE &&
      !s.view_hidden_decision && !s.is_terminal;
  }

  private renderTracks() {
    const s = this.shown!;
    const vp = s.victory_points;
    const vpText = vp === 0 ? t("app:play.vpEven") : `${Math.abs(vp)} ${sideName(vp > 0 ? "US" : "USSR")}`;
    const round = s.current_phase_name === "HEADLINE" ? t("app:play.headline")
      : s.current_phase_name === "SETUP" ? t("app:play.setup") : `AR${s.action_round}`;
    const phasing = s.phasing_player === "US" || s.phasing_player === "USSR" ? s.phasing_player : "";
    const china = s.china_card;
    document.getElementById("play-tracks")!.innerHTML = `
      <div class="trk-row">
        <span class="trk"><b>T${s.turn}</b> ${round}${phasing ? ` <span class="${sideCls(phasing)}">${sideName(phasing)}</span>` : ""}</span>
        <span class="trk defcon defcon-${s.defcon}">DEFCON <b>${s.defcon}</b></span>
        <span class="trk ${vp > 0 ? "us" : vp < 0 ? "ussr" : ""}">VP <b>${escapeHtml(vpText)}</b></span>
      </div>
      <div class="trk-row trk-small">
        <span class="trk">${t("app:play.milOps")} <span class="us">${s.mil_ops.US}</span>/<span class="ussr">${s.mil_ops.USSR}</span> <span class="play-dim">${t("app:play.of", { n: s.defcon })}</span></span>
        <span class="trk">${t("app:play.space")} <span class="us">${s.space.US}</span>/<span class="ussr">${s.space.USSR}</span></span>
        <span class="trk">${t("app:play.china")} <span class="${sideCls(china.holder)}">${sideName(china.holder)}</span>${china.playable ? "" : ` <span class="play-dim">${t("app:play.faceDown")}</span>`}</span>
      </div>`;
  }

  private renderStatus() {
    const el = document.getElementById("play-status")!;
    const g = this.online;
    let mine = false;
    let text = "";
    if (this.practice) {
      text = t("app:play.practiceStatus", { side: sideName(this.viewSide) });
      mine = true;
    } else if (g) {
      const parts: string[] = [];
      if (g.side) parts.push(t("app:online.you", { side: `<span class="${sideCls(g.side)}">${sideName(g.side)}</span>` }));
      if (g.status === "connecting") parts.push(t("app:online.connecting"));
      else if (g.status === "offline") parts.push(t("app:online.offline"));
      else if (g.status === "desync") parts.push(t("app:online.desync", { error: escapeHtml(g.error) }));
      else if (g.side) {
        const them = otherSeat(g.side);
        const p = g.seen[them];
        const word = p === "here" ? t("app:online.opponentHere", { side: sideName(them) })
          : p === "away" ? t("app:online.opponentAway", { side: sideName(them) }) : t("app:play.opponentOffline", { side: sideName(them) });
        parts.push(`<span class="presence presence-${p}" title="${escapeHtml(t(`app:play.presenceTitle.${p}`))}"></span>${word}`);
        if (Date.now() < this.activeUntil && p !== "offline") parts.push(`<span class="pulse">${t("app:play.active", { side: sideName(them) })}</span>`);
      }
      if (this.full && g.side && g.seed !== null) {
        if (this.full.is_terminal) parts.push(t("app:online.over"));
        else {
          const d = deciderOf(this.full);
          mine = d === g.side;
          if (mine) parts.push(`<b>${t("app:online.yourMove")}</b>`);
          else if (d) parts.push(t("app:online.theirMove", { side: sideName(d) }));
        }
      }
      text = parts.join(" · ");
      el.dataset.status = g.status;
    }
    const bell = this.notifyState();
    if (bell === "ask" || bell === "install") text += ` <button class="btn btn-bell" data-notify>${t("app:play.notify")}</button>`;
    else if (bell === "blocked") text += ` <button class="btn btn-bell" data-notify title="${escapeHtml(t("app:play.notifyBlocked"))}">🔕</button>`;
    else if (bell === "on") text += ` <span class="play-dim" title="${escapeHtml(t("app:play.notifyOn"))}">🔔</span>`;
    el.innerHTML = text;
    el.classList.toggle("mine", mine && !this.practice);
    document.title = mine && !this.practice ? `● ${this.baseTitle}` : this.baseTitle;
  }

  private renderTabs() {
    const handCount = this.shown?.hands?.[this.viewSide]?.length ?? 0;
    document.querySelectorAll<HTMLButtonElement>(".play-tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === this.tab);
      if (b.dataset.tab === "hand") b.textContent = `${t("app:play.tabHand")} (${handCount})`;
      if (b.dataset.tab === "board") b.textContent = t("app:play.tabBoard");
      if (b.dataset.tab === "history") b.textContent = t("app:play.tabHistory");
    });
  }

  private renderMain() {
    if (this.tab === "hand") this.main().innerHTML = this.handHtml();
    else if (this.tab === "history") this.main().innerHTML = this.historyHtml();
    else this.main().innerHTML = this.region ? this.regionHtml(this.region) : this.boardHtml();
  }

  // ---- board ----------------------------------------------------------------------------------

  /** The open decision's country targets (none while it is the other side's). */
  private targets(): Set<number> {
    if (!this.isPointDecision()) return new Set();
    return new Set((this.shown!.legal_actions.valid_ids || []).filter(id => id < 84));
  }

  private countsHtml(us: Count, ussr: Count): string {
    return `<span class="us">${countText(us)}</span>/<span class="ussr">${countText(ussr)}</span>`;
  }

  private netHtml(slot: number): string {
    const r = this.scores?.regions.find(x => x.slot === slot);
    if (!r) return "";
    if (r.wins) return `<span class="${sideCls(r.wins)}">${t("app:play.wins", { side: sideName(r.wins) })}</span>`;
    if (r.net === 0) return `<span class="play-dim">${t("app:play.even")}</span>`;
    const side = r.net > 0 ? "US" : "USSR";
    return `<span class="${sideCls(side)}">+${Math.abs(r.net)} ${sideName(side)}</span>`;
  }

  private standingHtml(slot: number): string {
    const r = this.scores?.regions.find(x => x.slot === slot);
    if (!r) return "";
    const st = (s: RegionalStatus | null) => (s === "PRESENCE" ? t("app:play.standing.PRESENCE") : s === "DOMINATION"
      ? t("app:play.standing.DOMINATION") : s === "CONTROL" ? t("app:play.standing.CONTROL") : "–");
    return `<span class="us">${st(r.us.status)}</span> · <span class="ussr">${st(r.ussr.status)}</span>`;
  }

  private whereHtml(slot: number): string {
    const id = SCORING_CARDS.get(slot);
    if (id === undefined || !this.shown) return "";
    const w = cardWhere(this.shown, id, this.viewSide);
    return `<span class="where where-${w}">${t(`app:play.where.${w}`)}</span>`;
  }

  private boardHtml(): string {
    if (!this.scores || !this.shown) return "";
    const counts = regionCounts(this.scores);
    const targets = this.targets();
    const changed = new Set((this.shown.last_turn?.countries || []).map(c => c.id));
    const tiles = REGIONS.map(r => {
      const c = counts.get(r.slot)!;
      const ids = MAP_METADATA.countries.filter(x => x.region === r.name).map(x => x.id);
      const legal = ids.filter(id => targets.has(id)).length;
      const moved = ids.some(id => changed.has(id));
      const sea = r.slot === 1 ? counts.get(SE_ASIA.slot) : undefined;
      return `<button class="tile ${legal ? "tile-legal" : ""}" data-region="${escapeHtml(r.name)}">
        <div class="tile-head"><span class="tile-name">${escapeHtml(regionName(r.name))}</span>
          ${moved ? `<span class="tile-moved" title="${t("app:play.movedTitle")}">●</span>` : ""}
          ${legal ? `<span class="tile-legal-n">${t("app:play.targets", { n: legal })}</span>` : ""}</div>
        <div class="tile-counts">${this.countsHtml(c.us, c.ussr)}</div>
        <div class="tile-line">${this.standingHtml(r.slot)} <span class="tile-net">${this.netHtml(r.slot)}</span></div>
        ${sea ? `<div class="tile-line tile-sea">${escapeHtml(regionName(SE_ASIA.name))} ${this.countsHtml(sea.us, sea.ussr)} ${this.netHtml(SE_ASIA.slot)} ${this.whereHtml(SE_ASIA.slot)}</div>` : ""}
        <div class="tile-line">${t("app:play.scoringCard")} ${this.whereHtml(r.slot)}</div>
      </button>`;
    }).join("");
    const effects = (this.shown.flags || []).map(f => effectNameMessage(f)).filter(m => m !== null)
      .map(m => `<span class="chip">${messageHtml(m!)}</span>`).join("");
    return `${this.whatHappenedHtml()}
      ${this.spaceHtml()}
      <div class="tiles">${tiles}</div>
      ${effects ? `<div class="effects"><div class="play-label">${t("app:play.effects")}</div>${effects}</div>` : ""}
      <p class="play-legend play-dim">${t("app:play.legend")}</p>`;
  }

  /**
   * The Space Race in one block: both sides' boxes, then the privileges in force -- only ever one
   * side's (holding one means being ahead at its box, so the other side is behind every box it
   * could hold), in that side's colour -- and each side's next attempt.
   */
  private spaceHtml(): string {
    const s = this.shown!;
    const boxes = spaceRaceBoxes();
    if (!boxes.length) return "";
    const held = spaceAbilities(s.space, boxes);
    const pos = (side: Seat) => `<span class="${sideCls(side)}">${sideName(side)} <b>${s.space[side]}</b></span>`;
    const next = (side: Seat) => {
      const n = boxes[s.space[side] + 1];
      const tried = s.space_turns_used?.[side] ?? 0;
      return `<span class="${sideCls(side)}">${sideName(side)}</span> ${n ? t("tracks:next.text", { ops: n.minOps, roll: n.maxRoll }) : t("tracks:next.done")}${tried ? ` (${t("app:play.spaceTried", { n: tried })})` : ""}`;
    };
    const holder = held[0]?.side;
    return `<div class="space ${holder ? `space-${sideCls(holder)}` : ""}">
      <div class="space-head"><span class="play-label">${t("app:play.spaceRace")}</span> ${pos("US")} · ${pos("USSR")}</div>
      ${held.map(h => `<span class="space-ability ${sideCls(h.side)}" title="${escapeHtml(h.box.ability)}">${escapeHtml(h.box.abilityShort)}</span>`).join("")}
      <div class="space-next play-dim">${next("US")} · ${next("USSR")}</div>
    </div>`;
  }

  private regionHtml(region: string): string {
    const s = this.shown!;
    const slot = REGIONS.find(r => r.name === region)?.slot ?? 0;
    const counts = this.scores ? regionCounts(this.scores) : null;
    const c = counts?.get(slot);
    const targets = this.targets();
    const L = this.engine.layout;
    const mode = s.decision_context.op_mode;
    const verb = mode === L.op_modes.COUP ? t("app:play.coup") : mode === L.op_modes.REALIGN ? t("app:play.realign")
      : s.decision_context.resolving_card ? t("app:play.choose") : "+1";
    const changed = new Map((s.last_turn?.countries || []).map(x => [x.id, x]));
    const byId = countriesById(s);
    const groups = regionCountries(region).map(g => {
      const rows = g.ids.map(id => {
        const meta = COUNTRY.get(id)!;
        const n = byId.get(id);
        const us = n?.us_influence ?? 0, ussr = n?.ussr_influence ?? 0;
        const ctl = n?.controlled_by ?? "NONE";
        const legal = targets.has(id);
        return `<div class="crow ${legal ? "crow-legal" : ""} ctl-${sideCls(ctl) || "none"}" data-country="${id}">
          <span class="cname">${meta.battleground ? `<span class="bg">★</span>` : ""}${escapeHtml(countryName(id, meta.name))}
            <span class="stab">${meta.stability}</span>${changed.has(id) ? ` <span class="tile-moved">●</span>` : ""}</span>
          <span class="inf us ${ctl === "US" ? "ctl" : ""}">${us || ""}</span>
          <span class="inf ussr ${ctl === "USSR" ? "ctl" : ""}">${ussr || ""}</span>
          <span class="cact">${legal ? `<button class="btn btn-primary btn-act" data-target="${id}">${verb}</button>` : ""}</span>
        </div>`;
      }).join("");
      return `${g.group ? `<div class="play-label">${escapeHtml(regionName(g.group))}${counts?.get(SE_ASIA.slot) ? ` ${this.countsHtml(counts.get(SE_ASIA.slot)!.us, counts.get(SE_ASIA.slot)!.ussr)}` : ""}</div>` : ""}${rows}`;
    }).join("");
    return `<div class="region-head">
        <button class="btn btn-secondary" data-back>←</button>
        <span class="region-name">${escapeHtml(regionName(region))}</span>
        ${c ? `<span class="tile-counts">${this.countsHtml(c.us, c.ussr)}</span>` : ""}
        <span class="tile-net">${this.netHtml(slot)}</span>
      </div>
      <div class="tile-line">${this.standingHtml(slot)} · ${t("app:play.scoringCard")} ${this.whereHtml(slot)}</div>
      <div class="crows">${groups}</div>`;
  }

  // ---- hand -----------------------------------------------------------------------------------

  private cardHtml(id: number, opts: { playable?: boolean } = {}): string {
    const c = CARD.get(id);
    if (!c) return "";
    const scoring = c.name.endsWith("Scoring");
    return `<button class="card card-${c.side} ${opts.playable ? "card-playable" : ""}" data-card="${id}">
      <span class="card-ops">${scoring ? "S" : c.ops}</span>
      <span class="card-name">${escapeHtml(cardName(id, c.name))}</span>
      ${c.one_time ? `<span class="card-star">*</span>` : ""}
    </button>`;
  }

  private handHtml(): string {
    const s = this.shown!;
    const me = this.viewSide;
    const them = otherSeat(me);
    const mine = (s.hands?.[me] || []).slice().sort((a, b) => (CARD.get(b)?.ops ?? 0) - (CARD.get(a)?.ops ?? 0));
    const theirs = s.hands?.[them] || [];
    const hidden = s.hidden_cards?.[them] ?? 0;
    const pile = (ids: number[]) => ids.map(id => this.cardHtml(id)).join("") || `<span class="play-dim">–</span>`;
    return `<div class="play-label">${t("app:play.yourHand", { side: sideName(me) })}</div>
      <div class="cards">${pile(mine)}</div>
      <div class="play-label">${t("app:play.theirHand", { side: sideName(them), n: theirs.length + hidden })}</div>
      ${theirs.length ? `<div class="cards">${pile(theirs)}</div>` : ""}
      <p class="play-dim">${t("app:play.deck", { n: s.draw_deck_count })}</p>
      <details class="pile"><summary>${t("app:play.discards", { n: (s.discard_pile || []).length })}</summary><div class="cards">${pile(s.discard_pile || [])}</div></details>
      <details class="pile"><summary>${t("app:play.removed", { n: (s.removed_pile || []).length })}</summary><div class="cards">${pile(s.removed_pile || [])}</div></details>`;
  }

  private showCard(id: number) {
    const c = CARD.get(id);
    const s = this.shown;
    if (!c || !s) return;
    const L = this.engine.layout;
    const playable = this.canMove() && s.decision_context.decision_type === L.decision_types.SELECT_CARD &&
      (s.legal_actions.valid_ids || []).includes(id);
    this.sheet(`<div class="card-sheet card-${c.side}">
      <div class="card-sheet-head"><span class="card-ops">${c.ops}</span>
        <span class="card-sheet-name">${escapeHtml(cardName(id, c.name))}</span>
        <span class="play-dim">${c.side === "neutral" ? "" : sideName(c.side.toUpperCase())}${c.one_time ? " · *" : ""}</span></div>
      <p class="card-text">${escapeHtml(cardDescription(id, c.description))}</p>
      ${playable ? `<button class="btn btn-primary btn-big" data-play="${id}">${t("app:play.playCard", { card: escapeHtml(cardName(id, c.name)) })}</button>` : ""}
    </div>`);
    document.querySelector<HTMLButtonElement>("[data-play]")?.addEventListener("click", () => {
      this.closeSheet();
      this.act({ decision_type: L.decision_types.SELECT_CARD, primary_id: id, secondary_id: 0, flags: 0 });
    });
  }

  // ---- history --------------------------------------------------------------------------------

  private entries(): HistoryEntry[] {
    if (!this.shown || !this.session.start) return [];
    return history(this.engine, this.session.start, this.session.steps, this.shown.action_logs || []);
  }

  private upshotHtml(u: Upshot): string {
    const parts: string[] = [];
    for (const r of u.regions) {
      parts.push(`<span class="up-region">${escapeHtml(regionName(r.name))} ${this.countsHtml(r.before.us, r.before.ussr)} → ${this.countsHtml(r.after.us, r.after.ussr)}</span>`);
    }
    const inf = u.countries.flatMap(c => {
      const name = escapeHtml(countryName(c.id, c.name));
      const out: string[] = [];
      if (c.us) out.push(`<span class="us">${name} ${c.us > 0 ? "+" : "−"}${Math.abs(c.us)}</span>`);
      if (c.ussr) out.push(`<span class="ussr">${name} ${c.ussr > 0 ? "+" : "−"}${Math.abs(c.ussr)}</span>`);
      return out;
    });
    if (inf.length) parts.push(`<span class="up-inf">${inf.join(" ")}</span>`);
    if (u.vp) parts.push(`<span class="${u.vp > 0 ? "us" : "ussr"}">VP +${Math.abs(u.vp)} ${sideName(u.vp > 0 ? "US" : "USSR")}</span>`);
    if (u.defcon) parts.push(`<span class="up-defcon">DEFCON ${u.defcon[0]}→${u.defcon[1]}</span>`);
    return parts.length ? `<div class="upshot">${parts.join(" · ")}</div>` : "";
  }

  private entryHtml(h: HistoryEntry, i: number, open: boolean): string {
    const e = h.entry;
    const when = e.phase === "SETUP" ? t("app:play.setup") : e.phase === "HEADLINE" ? `T${e.turn} ${t("app:play.headline")}`
      : e.phase === "TURN_END" ? `T${e.turn}` : `T${e.turn} AR${e.ar}`;
    const pending = this.online && Math.min(h.step, this.session.steps.length) > this.committed;
    return `<div class="entry ${sideCls(e.player) ? `entry-${sideCls(e.player)}` : "entry-system"} ${pending ? "entry-pending" : ""}" data-entry="${i}">
      <div class="entry-head"><span class="entry-when">${when}</span>
        ${sideCls(e.player) ? `<span class="entry-side ${sideCls(e.player)}">${sideName(e.player)}</span>` : ""}
        <span class="entry-title">${messageHtml(e.title)}</span>
        ${pending ? `<span class="chip">${t("app:play.notSent")}</span>` : ""}</div>
      ${this.upshotHtml(h.upshot)}
      ${open ? `<div class="entry-lines">${e.lines.map(l => `<div>${lineHtml(l)}</div>`).join("")}</div>` : ""}
    </div>`;
  }

  private historyHtml(): string {
    const list = this.entries();
    if (!list.length) return `<p class="play-dim">${t("app:play.noHistory")}</p>`;
    return `<p class="play-dim play-legend">${t("app:play.historyHint")}</p>` +
      list.map((h, i) => this.entryHtml(h, i, this.expanded.has(i))).reverse().join("");
  }

  /** The other side's plays since your last one, on the board, until you move again. */
  private whatHappenedHtml(): string {
    const me = this.me;
    if (!me) return "";
    const list = this.entries();
    let k = list.length;
    while (k > 0 && list[k - 1].entry.player !== me) k--;
    const since = list.slice(k).filter(h => h.entry.player === otherSeat(me) || h.entry.phase === "TURN_END");
    if (!since.length) return "";
    const shown = since.slice(-5);
    return `<div class="happened"><div class="play-label">${t("app:play.whatHappened")}</div>
      ${shown.map(h => this.entryHtml(h, list.indexOf(h), false)).join("")}
      ${since.length > shown.length ? `<button class="btn btn-secondary" data-tab-go="history">${t("app:play.more", { n: since.length - shown.length })}</button>` : ""}
    </div>`;
  }

  // ---- the decision ---------------------------------------------------------------------------

  private renderDecision() {
    const s = this.shown!;
    const L = this.engine.layout;
    this.hud.render(s);
    const cards = document.getElementById("play-decision-cards")!;
    const mine = this.canMove();
    const ctx = s.decision_context;
    if (mine && ctx.decision_type === L.decision_types.SELECT_CARD && !ctx.resolving_card && !s.is_terminal) {
      const ids = (s.legal_actions.valid_ids || []).filter(id => id > 0 && CARD.has(id));
      cards.innerHTML = `<div class="cards">${ids.map(id => this.cardHtml(id, { playable: true })).join("")}</div>`;
    } else {
      cards.innerHTML = "";
    }
    const commit = document.getElementById("play-commit")!;
    const pending = this.pending();
    let html = "";
    if (s.is_terminal) {
      html += `<button class="btn btn-primary" data-download>${t("app:play.download")}</button>`;
    }
    if (this.practice && this.session.canUndo) {
      html += `<button class="btn btn-secondary" data-undo>${t("app:play.undo")}</button>`;
    } else if (pending > 0) {
      html += `<button class="btn btn-secondary" data-undo>${t("app:play.undo")}</button>`;
      if (!mine || s.is_terminal) html += `<button class="btn btn-primary" data-send>${t("app:play.send")}</button>`;
    }
    commit.innerHTML = html;
    document.getElementById("play-decision")!.classList.toggle("mine", mine && !s.is_terminal);
    document.getElementById("play-decision")!.classList.toggle("must-send", pending > 0 && (!mine || s.is_terminal));
  }

  // ---- chrome ---------------------------------------------------------------------------------

  private bindChrome() {
    document.querySelectorAll<HTMLButtonElement>(".play-tab").forEach(b => b.addEventListener("click", () => {
      this.tab = b.dataset.tab as Tab;
      if (this.tab !== "board") this.region = null;
      if (this.shown) {
        this.renderTabs();
        this.renderMain();
        this.main().scrollTop = 0;
        window.scrollTo(0, 0);
      }
    }));
    document.getElementById("play-sheet-close")!.addEventListener("click", () => this.closeSheet());
    document.getElementById("play-sheet")!.addEventListener("click", e => { if (e.target === e.currentTarget) this.closeSheet(); });
    // Everything drawn from state is redrawn often: one listener on the document.
    document.addEventListener("click", e => {
      const el = e.target as HTMLElement;
      const target = el.closest<HTMLElement>("[data-target]");
      if (target) {
        e.stopPropagation();
        this.act({ decision_type: this.engine.layout.decision_types.POINT_NODE, primary_id: Number(target.dataset.target), secondary_id: 0, flags: 0 });
        return;
      }
      const region = el.closest<HTMLElement>("[data-region]");
      if (region) {
        this.region = region.dataset.region!;
        this.renderMain();
        window.scrollTo(0, 0);
        return;
      }
      if (el.closest("[data-back]")) {
        this.region = null;
        this.renderMain();
        return;
      }
      const card = el.closest<HTMLElement>("[data-card]") ?? el.closest<HTMLElement>(".log-card[data-card-id]");
      if (card) {
        this.showCard(Number(card.dataset.card ?? card.dataset.cardId));
        return;
      }
      const entry = el.closest<HTMLElement>("[data-entry]");
      if (entry && this.tab === "history") {
        const i = Number(entry.dataset.entry);
        if (this.expanded.has(i)) this.expanded.delete(i); else this.expanded.add(i);
        this.renderMain();
        return;
      }
      const go = el.closest<HTMLElement>("[data-tab-go]");
      if (go) {
        this.tab = go.dataset.tabGo as Tab;
        this.renderTabs();
        this.renderMain();
        return;
      }
      if (el.closest("[data-notify]")) return void this.enableNotifications();
      if (el.closest("[data-undo]")) return this.undo();
      if (el.closest("[data-send]")) return this.send();
      if (el.closest("[data-download]")) return this.download();
      if (el.closest(".play-decision-head") && !el.closest("button")) {
        this.collapsed = !this.collapsed;
        document.getElementById("play-decision")!.classList.toggle("collapsed", this.collapsed);
      }
    });
  }

  private sheet(html: string) {
    document.getElementById("play-sheet-body")!.innerHTML = html;
    document.getElementById("play-sheet")!.classList.remove("hidden");
  }

  private closeSheet() {
    document.getElementById("play-sheet")!.classList.add("hidden");
  }

  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private toast(text: string, ms = 3000) {
    let el = document.getElementById("play-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "play-toast";
      el.className = "play-toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el!.classList.remove("show"), ms);
  }

  /** The maker of a room, before the friend has come: the invite link, once. */
  private maybeInvite() {
    const g = this.online;
    if (!g?.side || !this.invite || this.invited || g.seed === null) return;
    if (g.online[otherSeat(g.side)] || this.session.steps.length > 0) return;
    this.invited = true;
    const link = seatLink(location.href, this.room, this.invite);
    this.sheet(`<h2>${t("page:online.inviteTitle")}</h2>
      <p>${t("app:online.inviteText", { side: sideName(otherSeat(g.side)) })}</p>
      <input class="invite-link" readonly value="${escapeHtml(link)}">
      <div class="play-row">
        ${typeof navigator.share === "function" ? `<button class="btn btn-primary btn-big" data-share>${t("page:online.share")}</button>` : ""}
        <button class="btn btn-secondary btn-big" data-copy>${t("page:online.copy")}</button>
      </div>
      <p class="play-dim">${t("page:online.inviteNote")}</p>`);
    document.querySelector("[data-share]")?.addEventListener("click", () => {
      navigator.share?.({ title: "Twilight Struggle", url: link }).catch(() => {});
    });
    document.querySelector("[data-copy]")?.addEventListener("click", async e => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        (document.querySelector(".invite-link") as HTMLInputElement | null)?.select();
        document.execCommand("copy");
      }
      (e.target as HTMLElement).textContent = t("app:online.copied");
    });
  }

  /** The finished game as a .tslog.json replay (both hands: offered only once it is over). */
  private download() {
    if (!this.full?.is_terminal) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.session.replay(), null, 1)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ts_workbench_online_${this.room || "practice"}_${this.me ?? ""}.tslog.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await initLanguage();
  const app = new PlayApp();
  (window as unknown as { __play: PlayApp }).__play = app;
  await app.boot();
});
