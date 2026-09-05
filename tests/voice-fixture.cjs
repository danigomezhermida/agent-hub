// Synthetic microphone fixture, not a human recording. STT is doubled in browser UI tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = function fixture() {
  if (process.env.VOICE_FIXTURE) return process.env.VOICE_FIXTURE;
  const sampleRate = 48000, seconds = 6, samples = sampleRate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(sampleRate,24); wav.writeUInt32LE(sampleRate*2,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) {
    const t=i/sampleRate, active=t>=1 && t<3.5;
    const value=active ? Math.sin(2*Math.PI*230*t)*0.16+Math.sin(2*Math.PI*460*t)*0.05 : 0;
    wav.writeInt16LE(Math.round(value*32767),44+i*2);
  }
  const target=path.join(os.tmpdir(),'agenthub-voice-fixture-'+process.pid+'.wav');
  fs.writeFileSync(target,wav); process.on('exit',()=>{try{fs.unlinkSync(target);}catch{}});return target;
};
