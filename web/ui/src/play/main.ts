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
import { OnlineGame, abandonRoom, createRoomAsking, fetchRoom, pushKey, roomSocketUrl, seatLink, subscribeSeat, webSocketConnect } from "../game/online";
import { RoomSnapshot, Seat, otherSeat } from "../game/online_protocol";
import { applyWireSteps, sessionSteps, startOnlineGame } from "../game/online_session";
import { PLAY_ENDPOINT } from "../build_info";
import { CARDS_METADATA, MAP_METADATA } from "../metadata";
import { escapeHtml } from "../html";
import { LogLine, isCardArg, isCountryArg, lineHtml, messageHtml, param, strParam } from "../game/log";
import { groupLog } from "../game/log_view";
import { EFFECT_INFO_MAP, effectText } from "../cards_view";
import { spaceRaceBoxes } from "../tracks_view";
import { SHORT_NAMES } from "../map_view";
import { ABBR, CARD_H, CARD_W, MAP_W, SP_H, SP_W, regionMap } from "./region_map";
import { cardDescription, cardName, countryName, initLanguage, regionName, renderEnglish, sideName, t } from "../i18n";
import {
  Count, HistoryEntry, countriesById, REGIONS, SCORING_CARDS, SE_ASIA, Upshot, cardWhere, countText, history, notableLines,
  regionCountries, regionCounts, revealed, roundsIn, SCORING_VALUES, spaceAbilities,
} from "./summary";

type Tab = "board" | "hand" | "history";

const CARD = new Map(CARDS_METADATA.map(c => [c.id, c]));
const COUNTRY = new Map(MAP_METADATA.countries.map(c => [c.id, c]));

const sideCls = (s: string) => (s === "US" ? "us" : s === "USSR" ? "ussr" : "");

/** "AR3/6": the round and how many the phasing side has this turn (roundsIn). */
function arText(s: GameState): string {
  const side = s.phasing_player === "US" || s.phasing_player === "USSR" ? s.phasing_player : null;
  return side ? `AR${s.action_round}/${roundsIn(s, side)}` : `AR${s.action_round}`;
}

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

function forgetGame(room: string): void {
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify(loadGames().filter(g => g.room !== room)));
  } catch { /* no storage */ }
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
  /** A region as a grid of cards or as a map (region_map.ts); this device's choice. */
  private regionView: "grid" | "map" = (() => {
    // "cards" is what the grid was called at first.
    try { return ["grid", "cards"].includes(localStorage.getItem("ts.play.regionView") ?? "") ? "grid" : "map"; } catch { return "map"; }
  })();

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
    void this.fillGames();
    this.main().querySelectorAll<HTMLButtonElement>("[data-drop]").forEach(b => b.addEventListener("click", () =>
      void this.dropGame(b.dataset.drop!, b.dataset.over === "1")));
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
        const r = await createRoomAsking(PLAY_ENDPOINT, this.engine.fingerprint,
          refused => window.prompt(refused ? t("app:online.passwordWrong") : t("app:online.passwordAsk")));
        if (!r) {
          b.disabled = false;
          return;
        }
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
    const rows = games.map(g => `<div class="game-item" data-game="${escapeHtml(g.room)}">
        <a class="game-link" href="${escapeHtml(g.url)}">
          <span class="game-line"><span class="game-side ${sideCls(g.side)}">${sideName(g.side)}</span>
            <span class="game-state play-dim">${t("app:play.gameLoading")}</span></span>
          <span class="game-date play-dim">${escapeHtml(new Date(g.at).toLocaleDateString())}</span>
        </a>
        <button class="btn btn-secondary game-drop" data-drop="${escapeHtml(g.room)}">${t("app:play.abandon")}</button>
      </div>`).join("");
    return `<h2>${t("app:play.yourGames")}</h2>
      ${rows ? `<div class="game-list">${rows}</div>` : `<p class="play-dim">${t("app:play.noGames")}</p>`}
      <form class="paste-link" data-paste>
        <input name="link" type="url" placeholder="${escapeHtml(t("app:play.pastePlaceholder"))}" autocomplete="off">
        <button class="btn btn-secondary">${t("app:play.open")}</button>
      </form>`;
  }

  /** Each listed game's state, from the relay's steps played in this page's engine; games abandoned
   *  by either player leave the list. Games waiting on you go first. */
  private async fillGames() {
    const list = this.main().querySelector(".game-list");
    if (!list || !PLAY_ENDPOINT) return;
    const games = loadGames();
    const order: Array<{ room: string; rank: number }> = [];
    for (const g of games) {
      const item = list.querySelector<HTMLElement>(`[data-game="${CSS.escape(g.room)}"]`);
      const label = item?.querySelector(".game-state");
      const drop = item?.querySelector<HTMLButtonElement>(".game-drop");
      if (!item || !label) continue;
      try {
        const seat = new URL(g.url).searchParams.get("seat") || "";
        const snap = await fetchRoom(PLAY_ENDPOINT, g.room, seat);
        if (snap.abandoned && !snap.abandoned.forfeit) {
          forgetGame(g.room);
          item.remove();
          this.toast(t("app:play.wasAbandoned", { side: sideName(snap.abandoned.by) }));
          continue;
        }
        const st = this.gameState(snap);
        label.innerHTML = st.html;
        label.classList.toggle("play-dim", !st.mine);
        item.classList.toggle("game-mine", st.mine);
        if (st.over && drop) drop.textContent = t("app:play.remove");
        if (drop) drop.dataset.over = st.over ? "1" : "";
        order.push({ room: g.room, rank: st.mine ? 0 : st.over ? 2 : 1 });
      } catch {
        label.textContent = t("app:play.gameUnreachable");
        order.push({ room: g.room, rank: 3 });
      }
    }
    order.sort((a, b) => a.rank - b.rank);
    for (const o of order) {
      const el = list.querySelector(`[data-game="${CSS.escape(o.room)}"]`);
      if (el) list.appendChild(el);
    }
  }

  /** A game's position, played from its seed: turn, round, VP, and whose move -- or how it ended. */
  private gameState(snap: RoomSnapshot): { html: string; mine: boolean; over: boolean } {
    const e = this.engine;
    e.newGame(snap.seed);
    for (const player of [1, -1]) e.seat(player, e.currentRules);
    for (const [decision_type, primary_id, secondary_id, flags] of snap.steps) {
      if (e.step({ decision_type, primary_id, secondary_id, flags }, 0)) break;
    }
    const s = e.display();
    const vp = s.victory_points;
    const vpText = vp === 0 ? `VP ${t("app:play.vpEven")}` : `<span class="${vp > 0 ? "us" : "ussr"}">VP ${Math.abs(vp)} ${sideName(vp > 0 ? "US" : "USSR")}</span>`;
    if (snap.abandoned?.forfeit) {
      const winner = otherSeat(snap.abandoned.by);
      return { html: t("app:play.gameResigned", { side: `<span class="${sideCls(winner)}">${sideName(winner)}</span>`, loser: sideName(snap.abandoned.by), turn: s.turn }),
        mine: false, over: true };
    }
    if (s.is_terminal) {
      const u = e.terminalUtility();
      const winner = u > 0 ? "US" : u < 0 ? "USSR" : "";
      return { html: winner ? t("app:play.gameWon", { side: `<span class="${sideCls(winner)}">${sideName(winner)}</span>`, turn: s.turn })
        : t("app:play.gameDrawn"), mine: false, over: true };
    }
    const round = s.current_phase_name === "HEADLINE" ? t("app:play.headline") : s.current_phase_name === "SETUP" ? t("app:play.setup") : arText(s);
    const d = deciderOf(s);
    const mine = d === snap.side;
    const who = mine ? `<b>${t("app:online.yourMove")}</b>` : d ? t("app:online.theirMove", { side: sideName(d) }) : "";
    return { html: `T${s.turn} ${round} · ${vpText} · ${who}`, mine, over: false };
  }

  private async dropGame(room: string, over: boolean) {
    const g = loadGames().find(x => x.room === room);
    if (!g) return;
    if (!over) {
      if (!window.confirm(t("app:play.confirmAbandon"))) return;
      try {
        await abandonRoom(PLAY_ENDPOINT, room, new URL(g.url).searchParams.get("seat") || "");
      } catch (e) {
        this.toast(t("app:play.abandonFailed", { error: e instanceof Error ? e.message : String(e) }));
        return;
      }
    }
    forgetGame(room);
    this.main().querySelector(`[data-game="${CSS.escape(room)}"]`)?.remove();
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
        // A game abandoned or resigned changes the bar and the tabs too.
        const ended = !!this.online?.abandoned;
        if (this.full && !this.boardDirty && ended === this.ended) this.renderStatus();
        else this.update(false);
        this.ended = ended;
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

  /** The relay had said the game was abandoned or resigned, when the page last drew it. */
  private ended = false;

  /** Until when the other player's last tap shows. */
  private activeUntil = 0;

  // ---- notifications ----------------------------------------------------------------------------

  private get notifyKey(): string {
    return `ts.play.notify.${this.room}`;
  }

  private notifyState(): "on" | "ask" | "install" | "blocked" | "none" {
    if (!this.online || !this.me || this.online.abandoned) return "none";
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
    if (!g || g.seed === null || g.status === "desync" || g.abandoned || !this.full) return false;
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
    const chance = () => {
      const tag = this.session.tags[this.session.tags.length - 1];
      const shows = revealed(before, redactState(this.session.state(), side).card_locations);
      const facts = this.stepFacts();
      return { facts, rolled: !!tag?.rolled, random: !!tag?.rolled || shows || facts.some(l => l.mark === "✂") };
    };
    let outcome = chance();
    if (this.online) {
      if (outcome.random) {
        this.session.undo(false);   // nothing of it was drawn
        const what = outcome.rolled ? t("app:play.revealsDie") : t("app:play.revealsCards");
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
        outcome = chance();
      }
    }
    this.update();
    if (outcome.random && outcome.facts.length) this.showOutcome(outcome.facts);
  }

  /** What the step just taken did that was not up to the player, as its player may read it: the
   *  dice, a random discard, a card revealed or taken (`notableLines` of that step). */
  private stepFacts(): LogLine[] {
    const last = this.session.steps[this.session.steps.length - 1];
    if (!last) return [];
    const logs = redactState(this.session.state(), this.viewSide).action_logs || [];
    return groupLog(logs).flatMap(e => notableLines(e, last.step_index));
  }

  /** The outcome of a step of chance, until dismissed. */
  private showOutcome(facts: LogLine[]) {
    this.sheet(`<h2>${t("app:play.outcomeTitle")}</h2>
      <div class="facts facts-big">${facts.map(l => `<div>${this.factHtml(l)}</div>`).join("")}</div>
      <button class="btn btn-primary btn-big" data-close-sheet>${t("app:play.ok")}</button>`);
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
    if (mine && !this.wasMine) this.collapsed = false;
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
      : s.current_phase_name === "SETUP" ? t("app:play.setup") : arText(s);
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
      if (g.abandoned?.forfeit) {
        parts.push(`<b>${t("app:play.resignedBy", { side: sideName(g.abandoned.by), winner: `<span class="${sideCls(otherSeat(g.abandoned.by))}">${sideName(otherSeat(g.abandoned.by))}</span>` })}</b>`);
      } else if (g.abandoned) parts.push(`<b>${t("app:play.abandonedBy", { side: sideName(g.abandoned.by) })}</b>`);
      else if (this.full && g.side && g.seed !== null) {
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

  /** The game is over: played to its end, or resigned. */
  private get over(): boolean {
    return !!this.full?.is_terminal || !!this.online?.abandoned?.forfeit;
  }

  private renderTabs() {
    const resign = document.querySelector<HTMLElement>("[data-resign]");
    if (resign) resign.hidden = !this.online?.side || this.online.seed === null || !!this.online.abandoned || !!this.full?.is_terminal;
    const handCount = this.shown?.hands?.[this.viewSide]?.length ?? 0;
    document.querySelectorAll<HTMLButtonElement>("button.play-tab[data-tab]").forEach(b => {
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

  /**
   * What the region's scoring awards, from its card: Presence, Domination and Control (or that
   * Control wins), each standing a side holds now marked with a dot in its colour, then the bonuses.
   * Southeast Asia's: 1 VP a country, Thailand 2.
   */
  private valuesHtml(slot: number): string {
    if (slot === SE_ASIA.slot) return `<span class="vals">${t("app:play.scoring.seAsia")}</span>`;
    const v = SCORING_VALUES.get(slot);
    if (!v) return "";
    const r = this.scores?.regions.find(x => x.slot === slot);
    const level = (status: RegionalStatus, text: string) => {
      const dots = (["US", "USSR"] as Seat[]).filter(side => r?.[side === "US" ? "us" : "ussr"].status === status)
        .map(side => `<span class="${sideCls(side)}">●</span>`).join("");
      return `<span class="val ${dots ? "val-held" : ""}">${text}${dots}</span>`;
    };
    const control = v.control === "wins" ? t("app:play.scoring.controlWins") : t("app:play.scoring.control", { vp: v.control });
    return `<span class="vals">${level("PRESENCE", t("app:play.scoring.presence", { vp: v.presence }))} · ${level("DOMINATION", t("app:play.scoring.domination", { vp: v.domination }))} · ${level("CONTROL", control)}
      <span class="play-dim">· ${t("app:play.scoring.bg")}${v.adjacent ? ` · ${t("app:play.scoring.adjacent")}` : ""}</span></span>`;
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
    const effects = (this.shown.flags || []).filter(f => EFFECT_INFO_MAP[f] && effectText(f)).map(f => {
      const side = EFFECT_INFO_MAP[f].side;
      return `<button class="chip chip-effect ${side === "US" || side === "USSR" ? `chip-${sideCls(side)}` : ""}" data-effect="${escapeHtml(f)}">${escapeHtml(effectText(f)!.name)}</button>`;
    }).join("");
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
    return `<div class="space ${holder ? `space-${sideCls(holder)}` : ""}" data-space role="button">
      <div class="space-head"><span class="play-label">${t("app:play.spaceRace")}</span> ${pos("US")} · ${pos("USSR")}</div>
      ${held.map(h => `<span class="space-ability ${sideCls(h.side)}" title="${escapeHtml(h.box.ability)}">${escapeHtml(h.box.abilityShort)}</span>`).join("")}
      <div class="space-next play-dim">${next("US")} · ${next("USSR")}</div>
    </div>`;
  }

  /**
   * The whole Space Race track, in the sheet: each box from the first up -- what reaching it takes
   * (a card of N+ Ops, a roll of 1-M), the VP for reaching it first and second, and its privilege,
   * in its holder's colour while in force -- with each side's marker on its box and the boxes both
   * have passed dimmed; and each side's attempts this turn.
   */
  private showSpace() {
    const s = this.shown;
    const boxes = spaceRaceBoxes();
    if (!s || !boxes.length) return;
    const at = { US: s.space.US, USSR: s.space.USSR };
    const marker = (side: Seat) => `<span class="sp-marker ${sideCls(side)}">${escapeHtml(sideName(side))}</span>`;
    const rows = boxes.map(b => {
      const here = (["US", "USSR"] as Seat[]).filter(side => at[side] === b.box).map(marker).join("");
      const passed = b.box < Math.min(at.US, at.USSR);
      let ability = "";
      if (b.privilege) {
        const us = at.US >= b.box, ussr = at.USSR >= b.box;
        const holder: Seat | "" = us && !ussr ? "US" : ussr && !us ? "USSR" : "";
        const state = holder ? ` <span class="play-dim">· ${t("app:play.spaceHeld", { side: escapeHtml(sideName(holder)) })}</span>`
          : us && ussr ? ` <span class="play-dim">· ${t("app:play.spaceCancelled")}</span>` : "";
        ability = `<div class="sp-ability ${holder ? sideCls(holder) : ""}">★ ${escapeHtml(b.ability)}${state}</div>`;
      }
      const needs = b.box === 0 ? t("app:play.spaceStart")
        : t("app:play.spaceNeeds", { ops: b.minOps, roll: b.maxRoll });
      const vp = b.vpFirst || b.vpSecond ? `<span class="sp-vp">${t("app:play.spaceVp", { first: b.vpFirst, second: b.vpSecond })}</span>` : "";
      return `<div class="sp-box ${passed ? "sp-passed" : ""}">
        <div class="sp-line"><span class="sp-n">${b.box}</span><span class="sp-needs">${needs}</span>${vp}<span class="sp-here">${here}</span></div>
        ${ability}
      </div>`;
    }).reverse().join("");
    const tried = (side: Seat) => `<span class="${sideCls(side)}">${escapeHtml(sideName(side))} ${s.space_turns_used?.[side] ?? 0}</span>`;
    this.sheet(`<div class="space-sheet">
      <h2>${t("app:play.spaceRace")}</h2>
      <p class="play-dim">${t("app:play.spaceAttempts")} ${tried("US")} · ${tried("USSR")}</p>
      <div class="sp-track">${rows}</div>
      <p class="play-dim play-legend">${t("app:play.spaceLegend")}</p>
    </div>`);
  }

  /** An effect in force, in the sheet: what it does, how long it lasts and the card it comes from (a
   *  tap opens it), in the colour of the side the effect table gives it -- the side it concerns, which
   *  is not always the side it helps (Red Scare on the US), so the page does not say "favours". */
  private showEffect(flag: string) {
    const info = EFFECT_INFO_MAP[flag], text = effectText(flag);
    if (!info || !text) return;
    const lasts = { PERMANENT: t("cards:effect.permanent"), TURN: t("cards:effect.turnOnly"),
      CONDITIONAL: t("cards:effect.conditional"), SPACE_PERK: t("cards:effect.spacePerk") }[info.duration];
    const side = info.side === "US" || info.side === "USSR" ? info.side : null;
    this.sheet(`<div class="effect-sheet">
      <h2 class="${side ? sideCls(side) : ""}">${escapeHtml(text.name)}</h2>
      <p class="play-dim">${lasts}</p>
      <p class="card-text">${escapeHtml(text.description)}</p>
      ${info.cardId !== undefined ? `<div class="play-label">${t("app:play.effectFrom")}</div><div class="cards">${this.cardHtml(info.cardId)}</div>` : ""}
    </div>`);
  }

  /** A country as a card: name (battlegrounds purple), stability, both Influence boxes. A target's
   *  whole card is its button (a long press opens its details); any other card opens its details. */
  private countryCardHtml(id: number, o: { legal: boolean; verb: string; changed: boolean; byId: ReturnType<typeof countriesById> }): string {
    const meta = COUNTRY.get(id)!;
    const n = o.byId.get(id);
    const us = n?.us_influence ?? 0, ussr = n?.ussr_influence ?? 0;
    const ctl = n?.controlled_by ?? "NONE";
    const name = escapeHtml(countryName(id, SHORT_NAMES[meta.name] ?? meta.name));
    const tag = o.legal ? "button" : "div";
    return `<${tag} class="ccard ${o.legal ? "ccard-legal" : ""} ctl-${sideCls(ctl) || "none"} ${meta.battleground ? "ccard-bg" : ""}" data-info="${id}"${o.legal ? ` data-target="${id}"` : ""}>
      <div class="ccard-head"><span class="ccard-name">${name}</span>${o.changed ? `<span class="tile-moved">●</span>` : ""}${o.legal ? `<span class="ccard-act">${o.verb}</span>` : ""}</div>
      <div class="ccard-row"><span class="stab">${meta.stability}</span>
        <span class="inf us ${ctl === "US" ? "ctl" : ""}">${us || ""}</span><span class="inf ussr ${ctl === "USSR" ? "ctl" : ""}">${ussr || ""}</span></div>
    </${tag}>`;
  }

  /**
   * A country's details, in the sheet: where it is, its Influence and what each side needs to control
   * it (control: at least the other side's Influence plus the stability), the superpower beside it, and
   * its neighbours as cards -- a tap on one opens its own.
   */
  private showCountry(id: number) {
    const s = this.shown;
    const meta = COUNTRY.get(id);
    if (!s || !meta) return;
    const byId = countriesById(s);
    const n = byId.get(id);
    const us = n?.us_influence ?? 0, ussr = n?.ussr_influence ?? 0;
    const need = (mine: number, theirs: number) => Math.max(0, theirs + meta.stability - mine);
    const ctl = n?.controlled_by ?? "NONE";
    const where = [regionName(meta.region), ...(meta.subregions || []).map(r => regionName(r))].join(" · ");
    const ids = new Map(MAP_METADATA.countries.map(c => [c.name, c.id]));
    const neighbours = meta.neighbours.map(nm => ids.get(nm)).filter((x): x is number => x !== undefined);
    const changed = new Set((s.last_turn?.countries || []).map(c => c.id));
    const superpower = meta.superpower_adjacent === "USA" ? "US" : meta.superpower_adjacent === "USSR" ? "USSR" : "";
    this.sheet(`<div class="country-sheet">
      <h2>${meta.battleground ? `<span class="bg">★</span> ` : ""}${escapeHtml(countryName(id, meta.name))}</h2>
      <p class="play-dim">${escapeHtml(where)} · ${t("app:play.stability", { n: meta.stability })}${meta.battleground ? ` · ${t("app:play.battleground")}` : ""}</p>
      <div class="country-inf"><span class="inf us ${ctl === "US" ? "ctl" : ""}">${us}</span><span class="inf ussr ${ctl === "USSR" ? "ctl" : ""}">${ussr}</span>
        <span>${ctl === "NONE" ? t("app:play.uncontrolled") : t("app:play.controlledBy", { side: `<span class="${sideCls(ctl)}">${sideName(ctl)}</span>` })}</span></div>
      <p>${t("app:play.toControl")} <span class="us">${sideName("US")} +${need(us, ussr)}</span> · <span class="ussr">${sideName("USSR")} +${need(ussr, us)}</span></p>
      ${superpower ? `<p>${t("app:play.besideSuperpower", { side: `<span class="${sideCls(superpower)}">${sideName(superpower)}</span>` })}</p>` : ""}
      <div class="play-label">${t("app:play.neighbours", { n: neighbours.length })}</div>
      <div class="ccards">${neighbours.map(nid => this.countryCardHtml(nid, { legal: false, verb: "", changed: changed.has(nid), byId })).join("")}</div>
    </div>`);
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
    const toggle = `<div class="view-toggle" role="group">
        <button class="${this.regionView === "grid" ? "on" : ""}" data-region-view="grid">${t("app:play.viewGrid")}</button>
        <button class="${this.regionView === "map" ? "on" : ""}" data-region-view="map">${t("app:play.viewMap")}</button>
      </div>`;
    const head = `<div class="region-head">
        <button class="btn btn-secondary" data-back>←</button>
        <span class="region-name">${escapeHtml(regionName(region))}</span>
        ${c ? `<span class="tile-counts">${this.countsHtml(c.us, c.ussr)}</span>` : ""}
        <span class="tile-net">${this.netHtml(slot)}</span>
      </div>
      <div class="tile-line">${this.valuesHtml(slot)}</div>
      <div class="tile-line">${this.standingHtml(slot)} · ${t("app:play.scoringCard")} ${this.whereHtml(slot)} ${toggle}</div>`;
    if (this.regionView === "map") {
      const sea = region === "Asia" ? counts?.get(SE_ASIA.slot) : undefined;
      const seaLine = sea ? `<div class="tile-line"><span class="sea-key"></span>${escapeHtml(regionName(SE_ASIA.name))} ${this.countsHtml(sea.us, sea.ussr)} ${this.netHtml(SE_ASIA.slot)} ${this.whereHtml(SE_ASIA.slot)} · ${this.valuesHtml(SE_ASIA.slot)}</div>` : "";
      return head + seaLine + this.regionMapHtml(region, targets, verb, new Set(changed.keys()), byId);
    }
    const groups = regionCountries(region).map(g => {
      const cards = g.ids.map(id => this.countryCardHtml(id, { legal: targets.has(id), verb, changed: changed.has(id), byId })).join("");
      const sea = g.group && counts?.get(SE_ASIA.slot);
      return `${g.group ? `<div class="play-label">${escapeHtml(regionName(g.group))}${sea ? ` ${this.countsHtml(sea.us, sea.ussr)}` : ""} <span class="play-dim">${this.valuesHtml(SE_ASIA.slot)}</span></div>` : ""}<div class="ccards">${cards}</div>`;
    }).join("");
    return head + groups;
  }

  /** The region as a map (region_map.ts): tiny cards where the map puts them, neighbours joined by
   *  lines, and each card's neighbours abroad as a tag. Taps work as on the grid's cards. */
  private regionMapHtml(region: string, targets: Set<number>, verb: string, changed: Set<number>, byId: ReturnType<typeof countriesById>): string {
    const m = regionMap(region);
    const at = new Map(m.spots.map(p => [p.id, p]));
    // Southeast Asia, tinted: each of its cards' boxes, widened, drawn as one shape.
    const seaIds = new Set(MAP_METADATA.countries.filter(c => (c.subregions || []).includes(SE_ASIA.name)).map(c => c.id));
    const pad = 7;
    const tint = m.spots.filter(p => seaIds.has(p.id))
      .map(p => `<rect x="${p.x - pad}" y="${p.y - pad}" width="${CARD_W + 2 * pad}" height="${CARD_H + 2 * pad}" rx="10"/>`).join("");
    const lines = m.linkPaths.map(d => `<path class="link" d="${d}"/>`).join("") + m.superpowers.flatMap(sp => sp.ids.map(id => {
      const q = at.get(id)!;
      return `<line class="sp-link sp-${sideCls(sp.side)}" x1="${sp.x + SP_W / 2}" y1="${sp.y + SP_H / 2}" x2="${q.x + CARD_W / 2}" y2="${q.y + CARD_H / 2}"/>`;
    })).join("");
    const powers = m.superpowers.map(sp =>
      `<span class="sp-node sp-${sideCls(sp.side)}" style="left:${sp.x}px;top:${sp.y}px">${escapeHtml(sideName(sp.side))}</span>`).join("");
    const cards = m.spots.map(p => {
      const meta = COUNTRY.get(p.id)!;
      const n = byId.get(p.id);
      const us = n?.us_influence ?? 0, ussr = n?.ussr_influence ?? 0;
      const ctl = n?.controlled_by ?? "NONE";
      const legal = targets.has(p.id);
      const tag = legal ? "button" : "div";
      const away = m.away.get(p.id);
      const full = escapeHtml(countryName(p.id, meta.name));
      return `<${tag} class="mcard ${legal ? "mcard-legal" : ""} ${meta.battleground ? "mcard-bg" : ""}" style="left:${p.x}px;top:${p.y}px" title="${legal ? `${escapeHtml(verb)}: ` : ""}${full}" data-info="${p.id}"${legal ? ` data-target="${p.id}"` : ""}>
        <span class="mc-head"><span class="mc-name">${escapeHtml(ABBR[meta.name] ?? meta.name)}</span>${changed.has(p.id) ? `<span class="mc-moved">●</span>` : ""}<span class="mc-stab">${meta.stability}</span></span>
        <span class="mc-row"><span class="inf us ${ctl === "US" ? "ctl" : ""}">${us || ""}</span><span class="inf ussr ${ctl === "USSR" ? "ctl" : ""}">${ussr || ""}</span></span>
        ${away ? `<span class="mc-away">→${escapeHtml(away.join(", "))}</span>` : ""}
      </${tag}>`;
    }).join("");
    return `<div class="rmap" style="width:${MAP_W}px;height:${m.height + 14}px">
      <svg class="rmap-links" width="${MAP_W}" height="${m.height}">${tint ? `<g class="sea-tint">${tint}</g>` : ""}${lines}</svg>${powers}${cards}</div>`;
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
      ${open ? `<div class="entry-lines">${e.lines.map(l => `<div>${lineHtml(l)}</div>`).join("")}</div>` : this.factsHtml(e)}
    </div>`;
  }

  /** A play's dice, random discards and cards moved, under its upshot (`notableLines`). */
  private factsHtml(e: HistoryEntry["entry"]): string {
    const lines = notableLines(e);
    return lines.length ? `<div class="facts">${lines.map(l => `<div>${this.factHtml(l)}</div>`).join("")}</div>` : "";
  }

  /** A line of `notableLines`: a die in short, anything else as the log words it. */
  private factHtml(l: LogLine): string {
    return (l.mark === "🎲" && this.rollHtml(l)) || lineHtml(l);
  }

  /**
   * A die line in short, each side in its colour: "🎲 Coup Iran: USSR 4+3 = 7 vs 4 → success, +3".
   * Read from the log line's parameters (game/describe.ts describeRoll); "" for one it does not know.
   */
  private rollHtml(l: LogLine): string {
    const m = l.msg;
    const p = (k: string) => param(m, k);
    const n = (k: string) => Number(p(k) ?? 0);
    const side = (s: string) => `<span class="${sideCls(s)}">${escapeHtml(sideName(s))}</span>`;
    const sideOf = (k: string) => side(strParam(m, k));
    const dice = (roll: number, mod: number, total: number) =>
      `<b>${roll}</b>${mod ? `${mod > 0 ? "+" : "−"}${Math.abs(mod)} = ${total}` : ""}`;
    const country = () => {
      const c = p("country");
      return isCountryArg(c) ? escapeHtml(countryName(c.country, c.name)) : escapeHtml(String(c ?? ""));
    };
    const card = () => {
      const c = p("card");
      return isCardArg(c) ? `<span class="log-card" data-card-id="${c.card}">${escapeHtml(cardName(c.card, c.name))}</span>` : escapeHtml(String(c ?? ""));
    };
    const result = p("result");
    const rk = typeof result === "object" && result !== null && "key" in result ? result : null;
    const rn = (k: string) => (rk ? Number(param(rk, k) ?? 0) : 0);
    const won = (s: string) => `<span class="${sideCls(s)}">${t("app:play.roll.wins", { side: escapeHtml(sideName(s)) })}</span>`;
    const ok = (good: boolean, text: string) => `<span class="${good ? "roll-ok" : "roll-no"}">${text}</span>`;
    let words = "";
    switch (m.key) {
      case "log:roll.coup":
      case "log:roll.coupWithCard": {
        const res = rk?.key === "log:roll.coupSucceeded" ? ok(true, t("app:play.roll.coupNet", { net: rn("net") })) : ok(false, t("app:play.roll.failed"));
        words = t("app:play.roll.coup", { country: country(), side: sideOf("roller"), dice: dice(n("roll"), n("mod"), n("total")), defense: n("defense"), result: res });
        break;
      }
      case "log:roll.realign": {
        const res = rk?.key === "log:roll.realignUs" ? `${won("US")}, ${t("app:play.roll.removes", { n: rn("net"), side: escapeHtml(sideName("USSR")) })}`
          : rk?.key === "log:roll.realignUssr" ? `${won("USSR")}, ${t("app:play.roll.removes", { n: rn("net"), side: escapeHtml(sideName("US")) })}`
          : t("app:play.roll.tie");
        words = t("app:play.roll.realign", { country: country(),
          us: `${side("US")} ${dice(n("usRoll"), n("usMod"), n("usTotal"))}`, ussr: `${side("USSR")} ${dice(n("ussrRoll"), n("ussrMod"), n("ussrTotal"))}`, result: res });
        break;
      }
      case "log:roll.space": {
        const res = rk?.key === "log:roll.spaceSucceeded" ? ok(true, t("app:play.roll.success")) : ok(false, t("app:play.roll.needed", { n: `≤${rn("threshold")}` }));
        words = t("app:play.roll.space", { box: n("box"), side: sideOf("roller"), roll: `<b>${n("roll")}</b>`, result: res });
        break;
      }
      case "log:roll.war":
      case "log:roll.warTargeting": {
        const res = rk?.key === "log:roll.warSucceeded" ? ok(true, t("app:play.roll.success")) : ok(false, t("app:play.roll.needed", { n: `≥${rn("threshold")}` }));
        words = t("app:play.roll.war", { card: card(), target: m.key === "log:roll.warTargeting" ? ` → ${country()}` : "", side: sideOf("roller"),
          dice: dice(n("roll"), n("mod"), n("total")), result: res });
        break;
      }
      case "log:roll.olympics": {
        const res = rk?.key === "log:roll.olympicsSponsor" ? won(strParam(m, "sponsor")) : rk?.key === "log:roll.olympicsOpponent" ? won(strParam(m, "opponent")) : t("app:play.roll.tie");
        words = t("app:play.roll.olympics", { sponsor: `${sideOf("sponsor")} ${dice(n("sponsorRoll"), n("sponsorTotal") - n("sponsorRoll"), n("sponsorTotal"))}`,
          opponent: `${sideOf("opponent")} <b>${n("opponentRoll")}</b>`, result: res });
        break;
      }
      case "log:roll.summit": {
        const res = rk?.key === "log:roll.summitUs" ? won("US") : rk?.key === "log:roll.summitUssr" ? won("USSR") : t("app:play.roll.tie");
        words = t("app:play.roll.summit", { us: `${side("US")} ${dice(n("usRoll"), n("usMod"), n("usTotal"))}`,
          ussr: `${side("USSR")} ${dice(n("ussrRoll"), n("ussrMod"), n("ussrTotal"))}`, result: res });
        break;
      }
      case "log:roll.trap": {
        const res = rk?.key === "log:roll.trapSucceeded" ? ok(true, t("app:play.roll.escaped")) : ok(false, t("app:play.roll.trapped"));
        words = t("app:play.roll.trap", { side: sideOf("roller"), roll: `<b>${n("roll")}</b>`, result: res });
        break;
      }
      default:
        return "";
    }
    return `🎲 ${words}`;
  }

  private historyHtml(): string {
    const list = this.entries();
    if (!list.length) return `<p class="play-dim">${t("app:play.noHistory")}</p>`;
    return `<p class="play-dim play-legend">${t("app:play.historyHint")}</p>` +
      list.map((h, i) => this.entryHtml(h, i, this.expanded.has(i))).reverse().join("");
  }

  private get happenedKey(): string {
    return `ts.play.happened.${this.room || "practice"}`;
  }

  /** The latest of the other side's plays whose box was dismissed on this device (its step). */
  private happenedDismissed(): string {
    try { return localStorage.getItem(this.happenedKey) ?? ""; } catch { return this.happenedMemo; }
  }

  private happenedMemo = "";

  /** The other side's plays since your last one, on the board, until you move again or dismiss them. */
  private whatHappenedHtml(): string {
    const me = this.me;
    if (!me) return "";
    const list = this.entries();
    let k = list.length;
    while (k > 0 && list[k - 1].entry.player !== me) k--;
    const since = list.slice(k).filter(h => h.entry.player === otherSeat(me) || h.entry.phase === "TURN_END");
    if (!since.length) return "";
    // Dismissed: hidden until the other side plays again.
    const latest = String(since[since.length - 1].step);
    if (this.happenedDismissed() === latest) return "";
    const shown = since.slice(-5);
    return `<div class="happened"><div class="happened-head"><span class="play-label">${t("app:play.whatHappened")}</span>
        <button class="happened-close" data-dismiss-happened="${latest}" aria-label="${escapeHtml(t("app:play.dismiss"))}">✕</button></div>
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
    const over = this.over;
    let html = "";
    if (over) {
      html += `<button class="btn btn-primary" data-download>${t("app:play.download")}</button>`;
    }
    if (this.practice && this.session.canUndo) {
      html += `<button class="btn btn-secondary" data-undo>${t("app:play.undo")}</button>`;
    } else if (pending > 0) {
      html += `<button class="btn btn-secondary" data-undo>${t("app:play.undo")}</button>`;
      if (!mine || s.is_terminal) html += `<button class="btn btn-primary" data-send>${t("app:play.send")}</button>`;
    }
    commit.innerHTML = html;
    const bar = document.getElementById("play-decision")!;
    const toggle = document.getElementById("play-collapse")!;
    const open = mine && !over;
    toggle.hidden = !open;
    toggle.textContent = this.collapsed ? t("app:play.showOptions") : t("app:play.hideOptions");
    bar.classList.toggle("collapsed", open && this.collapsed);
    bar.classList.toggle("mine", open);
    bar.classList.toggle("must-send", pending > 0 && (!mine || s.is_terminal));
    // The other side's move with nothing of yours to send: there is nothing to show down here.
    bar.classList.toggle("idle", !open && pending === 0 && !over);
  }

  // ---- chrome ---------------------------------------------------------------------------------

  /**
   * Pull down at the top of the middle to reload: the page scrolls only its middle (the tracks and
   * the decision stay put), so the browser's own pull-to-refresh has nothing to pull, and a Home
   * Screen app has none at all.
   */
  private bindPullToRefresh() {
    const main = this.main();
    const hint = document.createElement("div");
    hint.className = "pull-hint";
    main.before(hint);
    let start: number | null = null;
    let pulled = 0;
    const PULL = 80;
    main.addEventListener("touchstart", e => {
      start = main.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
      pulled = 0;
    }, { passive: true });
    main.addEventListener("touchmove", e => {
      if (start === null) return;
      pulled = Math.max(0, e.touches[0].clientY - start);
      hint.style.height = `${Math.min(pulled, PULL + 20) / 2}px`;
      hint.textContent = pulled > PULL ? t("app:play.pullRelease") : pulled > 20 ? t("app:play.pullDown") : "";
    }, { passive: true });
    main.addEventListener("touchend", () => {
      if (start !== null && pulled > PULL) {
        hint.textContent = t("app:play.pullReloading");
        location.reload();
        return;
      }
      start = null;
      hint.style.height = "0";
      hint.textContent = "";
    });
  }

  /** A long press opened a target's details: the click that ends it does not also play it. */
  private pressed = false;

  private bindChrome() {
    this.bindPullToRefresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let at = { x: 0, y: 0 };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    document.addEventListener("pointerdown", e => {
      this.pressed = false;
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-target][data-info]");
      if (!card) return;
      at = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        this.pressed = true;
        this.showCountry(Number(card.dataset.info));
      }, 500);
    });
    document.addEventListener("pointermove", e => {
      if (timer && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) cancel();
    });
    document.addEventListener("pointerup", cancel);
    // The click that ends a long press would land on the sheet it opened (closing it) or play the
    // target: it is swallowed before anything sees it.
    document.addEventListener("click", e => {
      if (!this.pressed) return;
      this.pressed = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    document.addEventListener("pointercancel", cancel);
    // The long press is ours, not the phone's text-selection or context menu.
    document.addEventListener("contextmenu", e => { if ((e.target as HTMLElement).closest(".ccard")) e.preventDefault(); });
    document.querySelectorAll<HTMLButtonElement>("button.play-tab[data-tab]").forEach(b => b.addEventListener("click", () => {
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
      const info = el.closest<HTMLElement>("[data-info]");
      if (info && (!info.dataset.target || info.closest("#play-sheet"))) {
        this.showCountry(Number(info.dataset.info));
        return;
      }
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
      const view = el.closest<HTMLElement>("[data-region-view]");
      if (view) {
        this.regionView = view.dataset.regionView === "map" ? "map" : "grid";
        try { localStorage.setItem("ts.play.regionView", this.regionView); } catch { /* no storage */ }
        this.renderMain();
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
      if (el.closest("[data-close-sheet]")) return this.closeSheet();
      if (el.closest("[data-space]")) return this.showSpace();
      const effect = el.closest<HTMLElement>("[data-effect]");
      if (effect) return this.showEffect(effect.dataset.effect!);
      const happened = el.closest<HTMLElement>("[data-dismiss-happened]");
      if (happened) {
        this.happenedMemo = happened.dataset.dismissHappened!;
        try { localStorage.setItem(this.happenedKey, this.happenedMemo); } catch { /* no storage */ }
        this.renderMain();
        return;
      }
      if (el.closest("[data-resign]")) return this.askResign();
      if (el.closest("[data-resign-confirm]")) return void this.resign();
      if (el.closest("[data-undo]")) return this.undo();
      if (el.closest("[data-send]")) return this.send();
      if (el.closest("[data-download]")) return this.download();
      if (el.closest("#play-collapse") || (el.closest(".play-decision-head") && !el.closest("button"))) {
        if (!this.canMove()) return;
        this.collapsed = !this.collapsed;
        if (this.shown) this.renderDecision();
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

  /** Resigning: what it does, and the button that does it. */
  private askResign() {
    const g = this.online;
    if (!g?.side || g.abandoned) return;
    this.sheet(`<h2>${t("app:play.resignTitle")}</h2>
      <p>${t("app:play.resignText", { side: sideName(otherSeat(g.side)) })}</p>
      <div class="play-row">
        <button class="btn btn-danger btn-big" data-resign-confirm>${t("app:play.resign")}</button>
        <button class="btn btn-secondary btn-big" data-close-sheet>${t("app:play.keepPlaying")}</button>
      </div>`);
  }

  private async resign() {
    this.closeSheet();
    try {
      await abandonRoom(PLAY_ENDPOINT, this.room, this.seat, true);
    } catch (e) {
      this.toast(t("app:play.resignFailed", { error: e instanceof Error ? e.message : String(e) }), 6000);
    }
  }

  /** The finished game as a .tslog.json replay (both hands: offered only once it is over). */
  private download() {
    if (!this.over) return;
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
