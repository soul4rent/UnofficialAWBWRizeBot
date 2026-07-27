/**
 * A small in-page control panel.
 *
 * Kept deliberately plain: no framework, no styling beyond what is needed to
 * stay legible over the game board, and it never touches AWBW's own DOM beyond
 * appending itself to <body>.
 *
 * Built node by node rather than with innerHTML: the seat labels interpolate
 * co_name straight from server data, and textContent means that can never be
 * markup.
 */
import { g } from "../awbw/globals.js";
import type { BotSettings } from "../main.js";

export interface PanelApi {
  playOnce(): Promise<number>;
  startAutoPlay(): Promise<void>;
  stopAutoPlay(): void;
  defaultSeat(): number | null;
  updateSettings(patch: Partial<BotSettings>): void;
}

const PANEL_ID = "awbw-bot-panel";

const STYLE = `
#${PANEL_ID} {
  position: fixed; right: 12px; bottom: 12px; z-index: 99999;
  width: 210px; padding: 10px 12px;
  background: rgba(20, 22, 28, 0.94); color: #e8e8ec;
  border: 1px solid #444a58; border-radius: 6px;
  font: 12px/1.45 system-ui, sans-serif;
}
#${PANEL_ID} h4 { margin: 0 0 8px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #9aa4b8; }
#${PANEL_ID} label { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
#${PANEL_ID} select, #${PANEL_ID} input[type=number] {
  flex: 1; min-width: 0; background: #12141a; color: inherit;
  border: 1px solid #444a58; border-radius: 3px; padding: 2px 4px; font: inherit;
}
#${PANEL_ID} button {
  width: 100%; margin-top: 6px; padding: 5px; cursor: pointer;
  background: #2f6feb; color: #fff; border: 0; border-radius: 3px; font: inherit;
}
#${PANEL_ID} button.secondary { background: #3a4050; }
#${PANEL_ID} .status { margin-top: 8px; color: #9aa4b8; min-height: 1.4em; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  init?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (init) Object.assign(node, init);
  return node;
}

/** A label wrapping a control, e.g. "Seat [select]". */
function field(text: string, control: HTMLElement): HTMLLabelElement {
  const label = el("label");
  label.appendChild(document.createTextNode(text));
  label.appendChild(control);
  return label;
}

export function mountPanel(api: PanelApi, settings: BotSettings): void {
  if (document.getElementById(PANEL_ID)) return;

  const style = el("style", { textContent: STYLE });
  document.head.appendChild(style);

  const panel = el("div", { id: PANEL_ID });
  panel.appendChild(el("h4", { textContent: "AWBW Bot" }));

  // --- seat picker
  const seatSelect = el("select");
  const players = g.players();
  for (const id of g.allViewerPId()) {
    const player = players[String(id)];
    const option = el("option", {
      value: String(id),
      textContent: `${id} — ${player?.co_name ?? "seat"}`,
      selected: id === settings.seatId,
    });
    seatSelect.appendChild(option);
  }
  seatSelect.addEventListener("change", () => {
    api.updateSettings({ seatId: Number(seatSelect.value) });
  });
  panel.appendChild(field("Seat ", seatSelect));

  // --- pacing
  const delayInput = el("input", {
    type: "number",
    min: "0",
    step: "100",
    value: String(settings.actionDelayMs),
  });
  delayInput.addEventListener("change", () => {
    api.updateSettings({ actionDelayMs: Number(delayInput.value) });
  });
  panel.appendChild(field("Delay ", delayInput));

  // --- dry run
  const dryInput = el("input", { type: "checkbox", checked: settings.dryRun });
  const dryLabel = el("label");
  dryLabel.appendChild(dryInput);
  dryLabel.appendChild(document.createTextNode(" Dry run"));
  panel.appendChild(dryLabel);

  // --- status line, declared before the handlers that write to it
  const status = el("div", { className: "status" });

  dryInput.addEventListener("change", () => {
    api.updateSettings({ dryRun: dryInput.checked });
    status.textContent = dryInput.checked ? "dry run: actions are logged only" : "";
  });

  // --- play one turn
  const playButton = el("button", { textContent: "Play this turn" });
  playButton.addEventListener("click", async () => {
    playButton.disabled = true;
    status.textContent = "playing…";
    try {
      const count = await api.playOnce();
      status.textContent = count < 0 ? "not this seat's turn" : `done — ${count} actions`;
    } finally {
      playButton.disabled = false;
    }
  });
  panel.appendChild(playButton);

  // --- auto-play toggle
  const autoButton = el("button", {
    textContent: "Start auto-play",
    className: "secondary",
  });
  let auto = false;
  autoButton.addEventListener("click", async () => {
    auto = !auto;
    if (auto) {
      autoButton.textContent = "Stop auto-play";
      status.textContent = "auto-play armed";
      await api.startAutoPlay();
      // startAutoPlay only returns once auto-play is switched off.
      auto = false;
      autoButton.textContent = "Start auto-play";
      status.textContent = "idle";
    } else {
      api.stopAutoPlay();
    }
  });
  panel.appendChild(autoButton);

  panel.appendChild(status);
  document.body.appendChild(panel);
}
