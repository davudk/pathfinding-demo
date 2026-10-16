import GUI from 'lil-gui';
import { TUNING_DEFS, defaultTuning, type Tuning } from '../shared/tuning';
import type { SimCommand } from '../shared/protocol';

export interface DisplayOptions {
  colorBlind: boolean;
  orderLines: boolean;
  edgePan: boolean;
  stats: boolean;
}

/** F5: live locomotion tuning (sent to the sim as deterministic commands) + display options. */
export class TuningPanel {
  private readonly gui: GUI;
  private readonly values: Tuning = defaultTuning();
  readonly display: DisplayOptions = { colorBlind: false, orderLines: true, edgePan: true, stats: true };

  constructor(send: (cmd: SimCommand) => void, onDisplay: (d: DisplayOptions) => void) {
    this.gui = new GUI({ title: 'Tuning (F5)', width: 280 });
    this.gui.domElement.classList.add('tuning');
    this.gui.hide();
    const folders = new Map<string, GUI>();
    for (const d of TUNING_DEFS) {
      let f = folders.get(d.group);
      if (!f) {
        f = this.gui.addFolder(d.group);
        folders.set(d.group, f);
      }
      f.add(this.values, d.key, d.min, d.max, d.step).name(d.label).onChange((v: number) => send({ kind: 'tune', key: d.key, value: v }));
    }
    this.gui.add({ reset: () => this.reset(send) }, 'reset').name('Reset to defaults');
    const disp = this.gui.addFolder('Display');
    disp.add(this.display, 'colorBlind').name('Colour-blind palette').onChange(() => onDisplay(this.display));
    disp.add(this.display, 'orderLines').name('Order lines').onChange(() => onDisplay(this.display));
    disp.add(this.display, 'edgePan').name('Screen-edge pan').onChange(() => onDisplay(this.display));
    disp.add(this.display, 'stats').name('Stats overlay').onChange(() => onDisplay(this.display));
  }

  toggle(): void {
    if (this.gui._hidden) this.gui.show();
    else this.gui.hide();
  }

  private reset(send: (cmd: SimCommand) => void): void {
    const d = defaultTuning();
    for (const def of TUNING_DEFS) {
      this.values[def.key] = d[def.key];
      send({ kind: 'tune', key: def.key, value: d[def.key] });
    }
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}
