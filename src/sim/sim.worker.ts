/// Simulation worker entry: owns the World and publishes snapshots to the main thread.
import type { FromSim, Port, ToSim } from '../shared/protocol';
import { SimRunner } from './host/runner';
import { SharedRingSink, TransferSink } from './host/sinks';

const port = self as unknown as Port<FromSim, ToSim>;
let runner: SimRunner | null = null;
let transferSink: TransferSink | null = null;

port.onmessage = (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        let sink;
        if (msg.transport === 'sab' && msg.sab) {
          sink = new SharedRingSink(msg.sab);
        } else {
          transferSink = new TransferSink((tick, buffer) => {
            port.postMessage({ type: 'snapshot', tick, buffer }, [buffer]);
          });
          sink = transferSink;
        }
        runner = new SimRunner(msg.scene, sink);
        port.postMessage({ type: 'ready', mapW: runner.world.mapW, mapH: runner.world.mapH });
        runner.start();
        break;
      }
      case 'command':
        runner?.enqueue(msg.cmd);
        break;
      case 'control':
        runner?.control(msg.paused, msg.timeScale, msg.step);
        break;
      case 'returnBuffer':
        transferSink?.giveBack(msg.buffer);
        break;
    }
  } catch (err) {
    port.postMessage({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
