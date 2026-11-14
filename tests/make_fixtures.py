# Genera MIDIs de prueba y las notas esperadas según pretty_midi/mido.
import json, random, sys
import mido, pretty_midi
out = sys.argv[1]
random.seed(7)

# 1) Multi-instrumento con cambios de tempo y batería (formato 1)
pm = pretty_midi.PrettyMIDI(initial_tempo=96)
for prog, ch_is_drum, base in [(0, False, 60), (48, False, 48), (0, True, 36)]:
    inst = pretty_midi.Instrument(program=prog, is_drum=ch_is_drum)
    t = 0.0
    for i in range(120):
        d = random.choice([0.125, 0.25, 0.5])
        p = base + random.randint(0, 24) if not ch_is_drum else random.choice([36, 38, 42])
        inst.notes.append(pretty_midi.Note(velocity=random.randint(40, 110), pitch=p, start=t, end=t + d * 0.9))
        t += d
    inst.control_changes.append(pretty_midi.ControlChange(64, 127, 1.0))
    inst.control_changes.append(pretty_midi.ControlChange(64, 0, 3.0))
    pm.instruments.append(inst)
pm.write(f'{out}/multi.mid')
# inyectar cambios de tempo con mido (pretty_midi solo escribe el inicial)
mf = mido.MidiFile(f'{out}/multi.mid')
conductor = mf.tracks[0]
abs_t = 0; evs = []
for m in conductor:
    abs_t += m.time; evs.append((abs_t, m))
for tick, bpm in [(mf.ticks_per_beat * 8, 140), (mf.ticks_per_beat * 20, 70), (mf.ticks_per_beat * 33, 120)]:
    evs.append((tick, mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm))))
evs.sort(key=lambda x: (x[0], 0 if x[1].type != 'end_of_track' else 1))
conductor.clear(); last = 0
for tick, m in evs:
    conductor.append(m.copy(time=tick - last)); last = tick
mf.save(f'{out}/multi.mid')

def expected(path):
    p = pretty_midi.PrettyMIDI(path)
    notes = []
    for inst in p.instruments:
        for n in inst.notes:
            notes.append([round(n.start * 1000, 3), round(n.end * 1000, 3), n.pitch, n.velocity])
    notes.sort()
    return notes

# 2) Running status a mano (formato 0): note on 90 con datos repetidos y note-off como vel 0
def var(v):
    b = [v & 0x7f]
    v >>= 7
    while v:
        b.insert(0, (v & 0x7f) | 0x80); v >>= 7
    return bytes(b)
trk = bytearray()
trk += var(0) + bytes([0xff, 0x51, 3, 0x07, 0xa1, 0x20])        # 120 bpm
trk += var(0) + bytes([0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7])  # sysex GM on
trk += var(0) + bytes([0x90, 60, 100])
trk += var(0) + bytes([64, 90])                                   # running status
trk += var(480) + bytes([60, 0])                                  # off (vel 0)
trk += var(0) + bytes([64, 0])
trk += var(0) + bytes([0xb0, 64, 127])
trk += var(240) + bytes([0x91, 67, 80])
trk += var(240) + bytes([0x81, 67, 0])
trk += var(0) + bytes([0xff, 0x2f, 0])
data = b'MThd' + (6).to_bytes(4, 'big') + (0).to_bytes(2, 'big') + (1).to_bytes(2, 'big') + (480).to_bytes(2, 'big')
data += b'MTrk' + len(trk).to_bytes(4, 'big') + trk
open(f'{out}/running.mid', 'wb').write(data)

json.dump({'multi': expected(f'{out}/multi.mid'), 'running': expected(f'{out}/running.mid')}, open(f'{out}/expected.json', 'w'))
print('ok', len(expected(f'{out}/multi.mid')), expected(f'{out}/running.mid'))
