import { CliArchive } from '../../src/archive.ts';
import { killPoint } from '../../src/kill-point.ts';

if (process.argv.includes('session')) {
  const append = CliArchive.prototype.append;
  CliArchive.prototype.append = function (...args) {
    if (args[1] === '  同意  ' && process.env.T54_AGREEMENT_CUT === 'before') killPoint('agreement-checkpoint', 'before-original', 30000);
    const ack = Reflect.apply(append, this, args);
    if (args[1] === '  同意  ' && process.env.T54_AGREEMENT_CUT === 'after') killPoint('agreement-checkpoint', 'after-original', 30000);
    return ack;
  };
}
