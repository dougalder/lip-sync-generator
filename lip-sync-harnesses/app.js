/* ==========================================================================
   A small MP4 writer.

   WebCodecs hands back encoded chunks and a decoder configuration; nothing in
   the browser will put them in a container, so this does it: ftyp + moov +
   mdat, non-fragmented, with the sample tables built from the chunks.

   Handles an H.264 video track (avc1/avcC) or a VP9 one (vp09/vpcC), plus an
   optional AAC audio track (mp4a/esds). Chunks are interleaved a second at a
   time so the file behaves on a timeline.
   ========================================================================== */

const MP4 = (() => {
  const b1 = n => [n & 255];
  const b2 = n => [(n >> 8) & 255, n & 255];
  const b3 = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const b4 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const asc = s => Array.from(s, c => c.charCodeAt(0));
  const f16 = n => b4(Math.round(n * 65536));          // 16.16 fixed point

  /** Flatten numbers, nested arrays and Uint8Arrays into one byte array. */
  function flat(parts, out) {
    for (const p of parts) {
      if (typeof p === 'number') out.push(p);
      else if (p instanceof Uint8Array) { for (let i = 0; i < p.length; i++) out.push(p[i]); }
      else flat(p, out);
    }
    return out;
  }

  function box(type, ...parts) {
    const body = flat(parts, []);
    return [...b4(body.length + 8), ...asc(type), ...body];
  }
  const fullBox = (type, version, flags, ...parts) => box(type, b1(version), b3(flags), ...parts);

  const ZERO_MATRIX = [
    ...b4(0x00010000), ...b4(0), ...b4(0),
    ...b4(0), ...b4(0x00010000), ...b4(0),
    ...b4(0), ...b4(0), ...b4(0x40000000)
  ];

  /* ---- codec-specific description boxes ---- */

  function avcC(description) { return box('avcC', description); }

  function vpcC(width, height) {
    // WebCodecs gives VP9 no description, so state a plain 8-bit 4:2:0 BT.709
    // stream. Level is advisory; pick one that covers the frame size.
    const mbs = width * height;
    const level = mbs <= 512 * 512 ? 31 : mbs <= 1920 * 1080 ? 40 : 51;
    return fullBox('vpcC', 1, 0,
      b1(0),          // profile 0
      b1(level),
      b1((8 << 4) | (1 << 1) | 0),   // bitDepth 8, chroma 4:2:0 colocated, limited range
      b1(1), b1(1), b1(1),           // primaries / transfer / matrix: BT.709
      b2(0)                          // no codec initialisation data
    );
  }

  /** ES_Descriptor tree wrapping the AAC AudioSpecificConfig.
      Descriptor lengths are counted from the flattened bytes — counting array
      entries instead understates them, which lenient demuxers ignore and
      strict ones (QuickTime among them) reject. */
  function esds(description, trackId, maxBitrate, avgBitrate, bufferSize) {
    const len = n => [0x80, 0x80, 0x80, n & 255];       // always the 4-byte form
    const descriptor = (tag, body) => {
      const bytes = flat(body, []);
      return [tag, ...len(bytes.length), ...bytes];
    };
    const dsi = descriptor(0x05, [description]);
    const dcd = descriptor(0x04, [
      b1(0x40),                    // MPEG-4 audio
      b1(0x15),                    // audio stream
      b3(bufferSize || 0),
      b4(maxBitrate), b4(avgBitrate),
      dsi]);
    const sl = descriptor(0x06, [b1(0x02)]);
    const es = descriptor(0x03, [b2(trackId), b1(0), dcd, sl]);
    return fullBox('esds', 0, 0, es);
  }

  /* ---- sample tables ---- */

  function stts(durations) {
    const runs = [];
    for (const d of durations) {
      const last = runs[runs.length - 1];
      if (last && last[1] === d) last[0]++;
      else runs.push([1, d]);
    }
    return fullBox('stts', 0, 0, b4(runs.length), runs.map(([c, d]) => [b4(c), b4(d)]));
  }

  function stsz(sizes) {
    return fullBox('stsz', 0, 0, b4(0), b4(sizes.length), sizes.map(b4));
  }

  function stsc(chunks) {                      // chunks: array of sample counts
    const runs = [];
    chunks.forEach((count, i) => {
      const last = runs[runs.length - 1];
      if (!last || last[1] !== count) runs.push([i + 1, count, 1]);
    });
    return fullBox('stsc', 0, 0, b4(runs.length), runs.map(r => [b4(r[0]), b4(r[1]), b4(r[2])]));
  }

  const stco = offsets => fullBox('stco', 0, 0, b4(offsets.length), offsets.map(b4));

  /** Composition offsets, for encoders that reorder frames (B-frames). Version
      1 carries them signed, so no global shift is needed to keep them positive. */
  function ctts(offsets) {
    const runs = [];
    for (const o of offsets) {
      const last = runs[runs.length - 1];
      if (last && last[1] === o) last[0]++;
      else runs.push([1, o]);
    }
    return fullBox('ctts', 1, 0, b4(runs.length), runs.map(([c, o]) => [b4(c), b4(o | 0)]));
  }

  function stss(keyIndices) {
    return fullBox('stss', 0, 0, b4(keyIndices.length), keyIndices.map(b4));
  }

  /* ---- sample entries ---- */

  function visualSampleEntry(fmt, width, height, cfgBox) {
    const name = new Uint8Array(32);            // compressorname, first byte = length
    return box(fmt,
      b1(0), b1(0), b1(0), b1(0), b1(0), b1(0), // reserved
      b2(1),                                    // data_reference_index
      b2(0), b2(0), b4(0), b4(0), b4(0),        // pre_defined / reserved
      b2(width), b2(height),
      b4(0x00480000), b4(0x00480000),           // 72 dpi
      b4(0), b2(1),                             // reserved, frame_count
      name,
      b2(0x0018), b2(0xFFFF),                   // depth, pre_defined = -1
      cfgBox);
  }

  function audioSampleEntry(channels, sampleRate, cfgBox) {
    return box('mp4a',
      b1(0), b1(0), b1(0), b1(0), b1(0), b1(0),
      b2(1),                                    // data_reference_index
      b4(0), b4(0),                             // reserved
      b2(channels), b2(16),                     // channel count, sample size
      b2(0), b2(0),                             // pre_defined, reserved
      f16(Math.min(sampleRate, 65535)),         // 16.16 sample rate
      cfgBox);
  }

  /* ---- track ---- */

  function trak(t, movieTimescale, movieDuration) {
    const isVideo = t.kind === 'video';
    const media = box('minf',
      isVideo ? box('vmhd', b1(0), b3(1), b2(0), b2(0), b2(0), b2(0))
              : box('smhd', b1(0), b3(0), b2(0), b2(0)),
      box('dinf', fullBox('dref', 0, 0, b4(1), fullBox('url ', 0, 1))),
      box('stbl',
        fullBox('stsd', 0, 0, b4(1), t.sampleEntry),
        stts(t.durations),
        ...(t.ctsOffsets && t.ctsOffsets.some(o => o !== 0) ? [ctts(t.ctsOffsets)] : []),
        ...(isVideo && t.keyIndices.length ? [stss(t.keyIndices)] : []),
        stsc(t.chunkCounts),
        stsz(t.sizes),
        stco(t.chunkOffsets)));

    const edit = t.editStart
      ? [box('edts', fullBox('elst', 0, 0, b4(1),
          b4(Math.round(t.duration / t.timescale * movieTimescale)),
          b4(t.editStart), b2(1), b2(0)))]
      : [];

    return box('trak',
      fullBox('tkhd', 0, 3,
        b4(0), b4(0),                           // creation, modification
        b4(t.id), b4(0),                        // track_ID, reserved
        b4(Math.round(t.duration / t.timescale * movieTimescale)),
        b4(0), b4(0),                           // reserved[2]
        b2(0),                                  // layer
        b2(0),                                  // alternate_group
        b2(isVideo ? 0 : 0x0100),               // volume (1.0 for audio)
        b2(0),                                  // reserved
        ZERO_MATRIX,
        f16(isVideo ? t.width : 0), f16(isVideo ? t.height : 0)),
      ...edit,
      box('mdia',
        fullBox('mdhd', 0, 0, b4(0), b4(0), b4(t.timescale), b4(t.duration), b2(0x55C4), b2(0)),
        fullBox('hdlr', 0, 0, b4(0), asc(isVideo ? 'vide' : 'soun'), b4(0), b4(0), b4(0),
                asc(isVideo ? 'VideoHandler' : 'SoundHandler'), b1(0)),
        media));
  }

  /* ---- interleaving ---- */

  /** Group samples into chunks of about one second so the tracks interleave. */
  function chunkify(samples, timescale) {
    const chunks = [];
    let cur = [], t = 0, chunkStart = 0;
    for (const s of samples) {
      if (cur.length && t - chunkStart >= timescale) { chunks.push(cur); cur = []; chunkStart = t; }
      cur.push(s);
      t += s.duration;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /**
   * @param {object} video {codec:'avc1'|'vp09', width, height, timescale, description?, samples:[{data,duration,isKey,cts?}]}
   * @param {object|null} audio {sampleRate, channels, description, editStart, samples:[{data,duration}]}
   */
  function build(video, audio) {
    const MOVIE_TS = 1000;
    const tracks = [];

    const vChunks = chunkify(video.samples, video.timescale);
    tracks.push({
      kind: 'video', id: 1, timescale: video.timescale,
      width: video.width, height: video.height,
      sampleEntry: video.codec === 'avc1'
        ? visualSampleEntry('avc1', video.width, video.height, avcC(video.description))
        : visualSampleEntry('vp09', video.width, video.height, vpcC(video.width, video.height)),
      durations: video.samples.map(s => s.duration),
      sizes: video.samples.map(s => s.data.length),
      keyIndices: video.samples.map((s, i) => s.isKey ? i + 1 : 0).filter(Boolean),
      ctsOffsets: video.samples.map(s => s.cts || 0),
      // With reordering, the first sample presents later than it decodes. An
      // edit list trims that delay so the picture still starts at zero.
      editStart: Math.max(0, video.samples.length ? (video.samples[0].cts || 0) : 0),
      duration: video.samples.reduce((a, s) => a + s.duration, 0),
      chunks: vChunks, chunkCounts: vChunks.map(c => c.length), chunkOffsets: vChunks.map(() => 0)
    });

    if (audio && audio.samples.length) {
      const aChunks = chunkify(audio.samples, audio.sampleRate);
      tracks.push({
        kind: 'audio', id: 2, timescale: audio.sampleRate,
        sampleEntry: audioSampleEntry(audio.channels, audio.sampleRate,
          esds(audio.description, 2, audio.bitrate || 128000, audio.bitrate || 128000,
               Math.max(...audio.samples.map(s => s.data.length)))),
        durations: audio.samples.map(s => s.duration),
        sizes: audio.samples.map(s => s.data.length),
        keyIndices: [],
        editStart: audio.editStart || 0,
        duration: audio.samples.reduce((a, s) => a + s.duration, 0),
        chunks: aChunks, chunkCounts: aChunks.map(c => c.length), chunkOffsets: aChunks.map(() => 0)
      });
    }

    const movieDuration = Math.round(Math.max(
      ...tracks.map(t => t.duration / t.timescale)) * MOVIE_TS);

    // Interleave the chunk lists, then lay the payload out in that order.
    const order = [];
    const maxChunks = Math.max(...tracks.map(t => t.chunks.length));
    for (let i = 0; i < maxChunks; i++) {
      for (const t of tracks) if (t.chunks[i]) order.push({ track: t, index: i, samples: t.chunks[i] });
    }
    let payloadSize = 0;
    for (const c of order) for (const s of c.samples) payloadSize += s.data.length;

    const ftyp = box('ftyp', asc('isom'), b4(0x200),
      asc('isom'), asc('iso2'), asc(video.codec === 'avc1' ? 'avc1' : 'iso4'), asc('mp41'));

    const buildMoov = () => box('moov',
      fullBox('mvhd', 0, 0, b4(0), b4(0), b4(MOVIE_TS), b4(movieDuration),
        b4(0x00010000), b2(0x0100), b2(0), b4(0), b4(0), ZERO_MATRIX,
        b4(0), b4(0), b4(0), b4(0), b4(0), b4(0), b4(tracks.length + 1)),
      ...tracks.map(t => trak(t, MOVIE_TS, movieDuration)));

    // Offsets sit in fixed-width fields, so measuring a first pass with zeros
    // gives the exact header size the real offsets will occupy.
    const headerSize = ftyp.length + buildMoov().length + 8;
    let cursor = headerSize;
    for (const c of order) {
      c.track.chunkOffsets[c.index] = cursor;
      for (const s of c.samples) cursor += s.data.length;
    }

    const moov = buildMoov();
    const out = new Uint8Array(ftyp.length + moov.length + 8 + payloadSize);
    let o = 0;
    out.set(ftyp, o); o += ftyp.length;
    out.set(moov, o); o += moov.length;
    out.set([...b4(payloadSize + 8), ...asc('mdat')], o); o += 8;
    for (const c of order) for (const s of c.samples) { out.set(s.data, o); o += s.data.length; }
    return out;
  }

  return { build };
})();


/* ==========================================================================
   A small MP4/MOV audio demuxer.

   `decodeAudioData` is a decoder, not a demuxer, and it turns down plenty of
   QuickTime files the same browser will play — ProRes movies, PCM tracks,
   camera .mov variants. This walks the container itself, pulls out the sound
   track, and either decodes it with WebCodecs (AAC, Opus, MP3, FLAC) or reads
   it straight when the track is uncompressed PCM.

   Exact and immediate: no playback, no drift.
   ========================================================================== */

const Demux = (() => {

  const fourcc = (dv, p) =>
    String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

  /** Immediate children of the byte range [start, end). */
  function boxes(dv, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = fourcc(dv, p + 4);
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = Number(dv.getBigUint64(p + 8));
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) break;
      out.push({ type, start: p + hdr, end: p + size });
      p += size;
    }
    return out;
  }
  const find = (list, t) => list.find(b => b.type === t);
  const kids = (dv, b) => boxes(dv, b.start, b.end);

  /** Walk the ES_Descriptor tree for the AAC AudioSpecificConfig. */
  function ascFromEsds(dv, box) {
    let p = box.start + 4;                       // version + flags
    const readLen = () => {
      let n = 0, b;
      do { b = dv.getUint8(p++); n = (n << 7) | (b & 0x7F); } while (b & 0x80);
      return n;
    };
    while (p < box.end) {
      const tag = dv.getUint8(p++);
      const size = readLen();
      if (tag === 0x03) p += 3;                  // ES_ID + flags
      else if (tag === 0x04) p += 13;            // decoder config header
      else if (tag === 0x05) return new Uint8Array(dv.buffer, p, size).slice();
      else p += size;
    }
    return null;
  }

  /** Expand stsc/stsz/stco into a flat list of byte ranges, in play order. */
  function sampleRanges(dv, stbl) {
    const stszB = find(stbl, 'stsz'), stscB = find(stbl, 'stsc');
    const stcoB = find(stbl, 'stco'), co64B = find(stbl, 'co64');
    if (!stszB || !stscB || (!stcoB && !co64B)) throw new Error('the sound track has no sample table');

    const uniform = dv.getUint32(stszB.start + 4);
    const count = dv.getUint32(stszB.start + 8);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) {
      sizes[i] = uniform || dv.getUint32(stszB.start + 12 + i * 4);
    }

    const chunkOffsets = [];
    if (stcoB) {
      const n = dv.getUint32(stcoB.start + 4);
      for (let i = 0; i < n; i++) chunkOffsets.push(dv.getUint32(stcoB.start + 8 + i * 4));
    } else {
      const n = dv.getUint32(co64B.start + 4);
      for (let i = 0; i < n; i++) chunkOffsets.push(Number(dv.getBigUint64(co64B.start + 8 + i * 8)));
    }

    const runs = [];
    const nRuns = dv.getUint32(stscB.start + 4);
    for (let i = 0; i < nRuns; i++) {
      const o = stscB.start + 8 + i * 12;
      runs.push({ first: dv.getUint32(o), per: dv.getUint32(o + 4) });
    }

    const out = [];
    let sample = 0;
    for (let r = 0; r < runs.length && sample < count; r++) {
      const lastChunk = r + 1 < runs.length ? runs[r + 1].first - 1 : chunkOffsets.length;
      for (let ch = runs[r].first; ch <= lastChunk && sample < count; ch++) {
        let at = chunkOffsets[ch - 1];
        if (at === undefined) break;
        for (let k = 0; k < runs[r].per && sample < count; k++) {
          out.push({ offset: at, size: sizes[sample] });
          at += sizes[sample];
          sample++;
        }
      }
    }
    return out;
  }

  /** Expand stts run-lengths into a duration for every sample. */
  function sampleDurations(dv, stbl, count) {
    const stts = find(stbl, 'stts');
    const out = new Array(count).fill(1024);
    if (!stts) return out;
    const n = dv.getUint32(stts.start + 4);
    let i = 0;
    for (let r = 0; r < n && i < count; r++) {
      const c = dv.getUint32(stts.start + 8 + r * 8);
      const delta = dv.getUint32(stts.start + 12 + r * 8);
      for (let k = 0; k < c && i < count; k++) out[i++] = delta;
    }
    return out;
  }

  /** media_time of the track's first edit — the encoder priming a muxer trims. */
  function editStart(dv, trak) {
    const edts = find(kids(dv, trak), 'edts');
    if (!edts) return 0;
    const elst = find(kids(dv, edts), 'elst');
    if (!elst) return 0;
    const version = dv.getUint8(elst.start);
    const n = dv.getUint32(elst.start + 4);
    if (!n) return 0;
    const p = elst.start + 8;
    const mt = version === 1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
    return Math.max(0, mt);
  }

  const PCM = {
    sowt: { bits: 16, float: false, big: false },
    twos: { bits: 16, float: false, big: true },
    in24: { bits: 24, float: false, big: true },
    in32: { bits: 32, float: false, big: true },
    fl32: { bits: 32, float: true, big: true },
    fl64: { bits: 64, float: true, big: true },
    raw:  { bits: 8,  float: false, big: false, unsigned: true }
  };

  /** WebCodecs codec strings for the compressed formats worth trying. */
  function codecString(format, asc) {
    if (format === 'mp4a') {
      if (asc && asc.length) {
        let objectType = (asc[0] >> 3) & 0x1F;
        if (objectType === 31 && asc.length > 1) objectType = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
        return 'mp4a.40.' + objectType;
      }
      return 'mp4a.40.2';
    }
    if (format === 'Opus' || format === 'opus') return 'opus';
    if (format === 'fLaC') return 'flac';
    if (format === '.mp3' || format === 'mp4a.6B') return 'mp3';
    if (format === 'alac') return 'alac';
    return format;
  }

/* Which video codecs every browser agrees on, and which are a coin toss.
   Reading this from the container turns a black rectangle into an instruction. */
const VIDEO_CODECS = {
  avc1: { name: 'H.264', universal: true },
  avc3: { name: 'H.264', universal: true },
  hvc1: { name: 'HEVC', universal: false, note: 'Safari plays HEVC; Chrome depends on the machine' },
  hev1: { name: 'HEVC', universal: false, note: 'Safari plays HEVC; Chrome depends on the machine' },
  ap4h: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  ap4x: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  apch: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  apcn: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  apcs: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  apco: { name: 'ProRes', universal: false, note: 'ProRes is macOS-only; Chrome cannot decode it' },
  av01: { name: 'AV1', universal: false, note: 'AV1 support varies by browser and machine' },
  vp09: { name: 'VP9', universal: false, note: 'VP9 in an MP4 is not something every player accepts' },
  mp4v: { name: 'MPEG-4 Part 2', universal: false },
  jpeg: { name: 'Motion JPEG', universal: false },
  mjpa: { name: 'Motion JPEG', universal: false }
};

  /** The first video track's codec and size, straight from the container. */
  function videoTrack(buffer) {
    const dv = new DataView(buffer);
    const top = find(boxes(dv, 0, buffer.byteLength), 'moov');
    if (!top) return null;
    for (const trak of kids(dv, top).filter(b => b.type === 'trak')) {
      const mdia = find(kids(dv, trak), 'mdia');
      if (!mdia) continue;
      const mk = kids(dv, mdia);
      const hdlr = find(mk, 'hdlr');
      if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'vide') continue;
      const minf = find(mk, 'minf');
      const stbl = minf && find(kids(dv, minf), 'stbl');
      if (!stbl) continue;
      const stsd = find(kids(dv, stbl), 'stsd');
      if (!stsd) continue;
      const e = stsd.start + 8;                 // first sample description
      const format = fourcc(dv, e + 4);
      // VisualSampleEntry: 8 box header, 8 SampleEntry, 16 pre_defined/reserved
      const width = dv.getUint16(e + 32);
      const height = dv.getUint16(e + 34);
      const known = VIDEO_CODECS[format];
      return {
        format, width, height,
        name: known ? known.name : format,
        universal: known ? !!known.universal : false,
        note: known && known.note ? known.note : ''
      };
    }
    return null;
  }

  /** Locate and describe the first sound track. */
  function soundTrack(buffer) {
    const dv = new DataView(buffer);
    const moov = find(boxes(dv, 0, buffer.byteLength), 'moov');
    if (!moov) throw new Error('no moov box: this is not an MP4 or MOV container');

    for (const trak of kids(dv, moov).filter(b => b.type === 'trak')) {
      const mdia = find(kids(dv, trak), 'mdia');
      if (!mdia) continue;
      const mk = kids(dv, mdia);
      const hdlr = find(mk, 'hdlr');
      if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'soun') continue;

      const mdhd = find(mk, 'mdhd');
      let timescale = 44100;
      if (mdhd) {
        const version = dv.getUint8(mdhd.start);
        timescale = version === 1
          ? dv.getUint32(mdhd.start + 20)
          : dv.getUint32(mdhd.start + 12);
      }

      const minf = find(mk, 'minf');
      const stbl = minf && find(kids(dv, minf), 'stbl');
      if (!stbl) continue;
      const sb = kids(dv, stbl);
      const stsd = find(sb, 'stsd');
      if (!stsd) continue;

      // first sample description
      const e = stsd.start + 8;
      const entryEnd = e + dv.getUint32(e);
      const format = fourcc(dv, e + 4);
      let p = e + 8 + 8;                          // 6 reserved + 2 data_reference_index
      const version = dv.getUint16(p); p += 2;
      p += 2 + 4;                                 // revision + vendor
      let channels = dv.getUint16(p); p += 2;
      let bits = dv.getUint16(p); p += 2;
      p += 2 + 2;                                 // compression id + packet size
      let sampleRate = dv.getUint32(p) / 65536; p += 4;

      let pcmFlags = null;
      if (version === 1) {
        p += 16;                                  // samples/packet, bytes/packet, bytes/frame, bytes/sample
      } else if (version === 2) {
        p += 4;                                   // sizeOfStructOnly
        sampleRate = dv.getFloat64(p); p += 8;
        channels = dv.getUint32(p); p += 4;
        p += 4;                                   // always7F000000
        bits = dv.getUint32(p); p += 4;
        pcmFlags = dv.getUint32(p); p += 4;
        p += 8;                                   // constBytesPerAudioPacket, constLPCMFramesPerAudioPacket
      }

      // QuickTime wraps the sample-entry extensions in a 'wave' box rather than
      // hanging them directly off the entry, which is why .mov files that look
      // identical to an .mp4 can come back with no codec configuration.
      let children = boxes(dv, p, entryEnd);
      const wave = find(children, 'wave');
      if (wave) children = children.concat(kids(dv, wave));
      let asc = null;
      const esds = find(children, 'esds');
      if (esds) asc = ascFromEsds(dv, esds);
      const dops = find(children, 'dOps');
      const dfla = find(children, 'dfLa');
      if (!asc && dops) asc = new Uint8Array(dv.buffer, dops.start, dops.end - dops.start).slice();
      if (!asc && dfla) asc = new Uint8Array(dv.buffer, dfla.start + 4, dfla.end - dfla.start - 4).slice();

      const ranges = sampleRanges(dv, sb);
      return {
        dv, format, version, channels: channels || 1, bits: bits || 16,
        sampleRate: sampleRate || timescale, timescale, pcmFlags, asc,
        ranges,
        durations: sampleDurations(dv, sb, ranges.length),
        editStart: editStart(dv, trak)
      };
    }
    throw new Error('this file has no sound track');
  }

  function pcmSpec(t) {
    if (t.format === 'lpcm' && t.pcmFlags !== null) {
      return { bits: t.bits, float: !!(t.pcmFlags & 1), big: !!(t.pcmFlags & 2), unsigned: !(t.pcmFlags & 4) && t.bits === 8 };
    }
    return PCM[t.format] || null;
  }

  function readPCM(t, buffer) {
    const spec = pcmSpec(t);
    if (!spec) throw new Error('unsupported PCM layout: ' + t.format);
    const bytes = spec.bits / 8;
    let total = 0;
    for (const r of t.ranges) total += r.size;
    const frames = Math.floor(total / (bytes * t.channels));
    const planes = [];
    for (let c = 0; c < t.channels; c++) planes.push(new Float32Array(frames));

    const dv = new DataView(buffer);
    let f = 0, c = 0;
    const scale = spec.float ? 1 : 1 / (2 ** (spec.bits - 1));
    for (const r of t.ranges) {
      for (let o = r.offset; o + bytes <= r.offset + r.size && f < frames; o += bytes) {
        let v;
        if (spec.float) v = spec.bits === 32 ? dv.getFloat32(o, !spec.big) : dv.getFloat64(o, !spec.big);
        else if (spec.bits === 8) v = (spec.unsigned ? dv.getUint8(o) - 128 : dv.getInt8(o)) * scale * 2;
        else if (spec.bits === 16) v = dv.getInt16(o, !spec.big) * scale;
        else if (spec.bits === 24) {
          const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
          let raw = spec.big ? (b0 << 16) | (b1 << 8) | b2 : (b2 << 16) | (b1 << 8) | b0;
          if (raw & 0x800000) raw -= 0x1000000;
          v = raw * scale;
        } else v = dv.getInt32(o, !spec.big) * scale;
        planes[c][f] = v;
        if (++c === t.channels) { c = 0; f++; }
      }
    }
    return { planes, frames, sampleRate: t.sampleRate, channels: t.channels };
  }

  async function decodeCompressed(t, buffer, onProgress) {
    if (typeof AudioDecoder === 'undefined') throw new Error('this browser has no WebCodecs audio decoder');
    const codec = codecString(t.format, t.asc);
    const config = {
      codec, sampleRate: Math.round(t.sampleRate), numberOfChannels: t.channels,
      ...(t.asc ? { description: t.asc } : {})
    };
    const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) throw new Error('no decoder available for ' + codec);

    const chunks = [];
    let failure = null, outRate = Math.round(t.sampleRate), outCh = t.channels;
    const dec = new AudioDecoder({
      output: ad => {
        outRate = ad.sampleRate; outCh = ad.numberOfChannels;
        const planes = [];
        for (let c = 0; c < ad.numberOfChannels; c++) {
          const p = new Float32Array(ad.numberOfFrames);
          ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        chunks.push({ planes, frames: ad.numberOfFrames });
        ad.close();
      },
      error: e => { failure = e; }
    });
    dec.configure(config);

    let ts = 0;
    for (let i = 0; i < t.ranges.length && !failure; i++) {
      const r = t.ranges[i];
      dec.decode(new EncodedAudioChunk({
        type: 'key', timestamp: ts, data: new Uint8Array(buffer, r.offset, r.size)
      }));
      ts += 1e6 * 1024 / (t.sampleRate || 44100);
      if ((i & 255) === 255) {
        onProgress && onProgress(i / t.ranges.length);
        await new Promise(res => setTimeout(res, 0));
      }
    }
    await dec.flush();
    dec.close();
    if (failure) throw new Error((failure.message || failure) + '');
    if (!chunks.length) throw new Error('the decoder produced no audio');

    let frames = 0;
    for (const c of chunks) frames += c.frames;
    const planes = [];
    for (let c = 0; c < outCh; c++) planes.push(new Float32Array(frames));
    let at = 0;
    for (const c of chunks) {
      for (let ch = 0; ch < outCh; ch++) planes[ch].set(c.planes[Math.min(ch, c.planes.length - 1)], at);
      at += c.frames;
    }
    return { planes, frames, sampleRate: outRate, channels: outCh };
  }

  function toAudioBuffer(r) {
    let buf;
    const rate = Math.max(3000, Math.round(r.sampleRate));
    try {
      buf = new AudioBuffer({ length: r.frames, numberOfChannels: r.channels, sampleRate: rate });
    } catch (e) {
      const OCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      buf = new OCtor(r.channels, r.frames, rate).createBuffer(r.channels, r.frames, rate);
    }
    for (let c = 0; c < r.channels; c++) buf.copyToChannel(r.planes[c], c);
    return buf;
  }

  /** Pull the sound track out of an MP4/MOV/M4A as an AudioBuffer. */
  async function audio(buffer, onProgress) {
    const t = soundTrack(buffer);
    const raw = pcmSpec(t) && t.format !== 'mp4a';
    const result = raw ? readPCM(t, buffer) : await decodeCompressed(t, buffer, onProgress);
    if (!result.frames) throw new Error('the sound track is empty');
    return toAudioBuffer(result);
  }

  /**
   * The sound track as encoded samples, shaped for the MP4 writer. Copying it
   * beats re-encoding: no generation loss, no priming to guess at, and it
   * needs no encoder in the browser at all.
   * Returns null when the codec has no place in an MP4 audio track.
   */
  function passthrough(buffer) {
    const t = soundTrack(buffer);
    if (t.format !== 'mp4a' || !t.asc) return null;      // only AAC copies cleanly today
    const samples = t.ranges.map((r, i) => ({
      data: new Uint8Array(buffer, r.offset, r.size).slice(),
      duration: t.durations[i] || 1024
    }));
    if (!samples.length) return null;
    return {
      sampleRate: Math.round(t.timescale || t.sampleRate),
      channels: Math.min(2, t.channels),
      description: t.asc,
      samples,
      editStart: t.editStart || 0,
      bitrate: 128000,
      source: 'copied'
    };
  }

  return { audio, passthrough, soundTrack, videoTrack };
})();


/* ==========================================================================
   Lip Sync Generator — audio → viseme timing → transparent frames
   Everything runs in the page. No network, no upload, no dependencies.

   Layout of this file:
     1. Viseme vocabulary          5. Mouth rendering (4 styles + custom art)
     2. Signal processing          6. Exposure sheet + overview
     3. Viseme classifier          7. Playback transport
     4. Engine registry            8. ZIP writer + the three exports
   ========================================================================== */

/* ---------------------------------------------------------------- 1. visemes */

/* The one place the version is written. It shows under the title, it goes into
   the diagnostics, and it is printed in the README of every export — so a zip
   that turns up six months later says which build made it, and a screenshot of
   the window is enough to answer "which version are you on?".

   Semantic versioning: patch for a fix, minor for something new that breaks
   nothing, major for a change to how existing work behaves. Bump it here and
   nowhere else. */
const APP_VERSION = '1.14.1';

const VIS = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const VNAME = {
  X: 'Rest — silence',
  A: 'Closed — M B P',
  B: 'Slightly open — S T D K N R, EE',
  C: 'Open — EH AE',
  D: 'Wide open — AA',
  E: 'Rounded — O AO ER',
  F: 'Puckered — OO W',
  G: 'Teeth on lip — F V',
  H: 'Tongue — L'
};

const VCOL = {
  X: '#6E7885', A: '#B8556F', B: '#4A90C4', C: '#3D9E86', D: '#D3902F',
  E: '#8A6FC9', F: '#C9603F', G: '#7A9B3E', H: '#C05FA0'
};

/* Shape parameters, as fractions of the output box.
   round: 0 = wide lens, 1 = circle.  bite: teeth resting on the lower lip. */
const VP = {
  X: { w: .36, h: .035, round: .05, teeth: 0,   tongue: 0   },
  A: { w: .40, h: .016, round: 0,   teeth: 0,   tongue: 0   },
  B: { w: .42, h: .100, round: .05, teeth: .95, tongue: .15 },
  // C and D are 15% shorter than they were drawn, and the reason is practical
  // rather than phonetic. These two set the tallest frame in the set, so they
  // set the scale of the whole export: a Lego minifigure or a Barbie head has
  // perhaps a fifth of its face to spare for a mouth, and a D drawn at full
  // Preston Blair proportion forced the entire sheet to be scaled down to fit
  // it — which left every other shape too small to read. Shortening the two
  // extremes lets the sheet sit larger on the face. Width, roundness, teeth
  // and tongue are untouched; it is only the opening.
  C: { w: .45, h: .204, round: .18, teeth: .70, tongue: .30 },
  D: { w: .43, h: .357, round: .26, teeth: .60, tongue: .55 },
  E: { w: .31, h: .280, round: .72, teeth: .25, tongue: .15 },
  F: { w: .24, h: .225, round: 1,   teeth: 0,   tongue: 0   },
  G: { w: .41, h: .075, round: .03, teeth: 1,   tongue: 0, bite: 1 },
  H: { w: .42, h: .280, round: .10, teeth: .50, tongue: 1   }
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ------------------------------------------------------- 2. signal processing */

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, half = len >> 1;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + half], bi = im[i + k + half];
        const vr = br * cr - bi * ci, vi = br * ci + bi * cr;
        re[i + k] = ar + vr; im[i + k] = ai + vi;
        re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Linear-interpolating resampler. Analysis runs at 16 kHz: enough band for
    sibilants up to 8 k, and the right rate for order-18 LPC formants. */
function resample(input, srIn, srOut) {
  if (srIn === srOut) return input;
  const ratio = srIn / srOut;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = p | 0, frac = p - i0;
    const a = input[i0], b = input[i0 + 1] !== undefined ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Levinson-Durbin on the autocorrelation. Returns A(z) coefficients, a[0]=1. */
function lpc(x, order) {
  const n = x.length;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = k; i < n; i++) s += x[i] * x[i - k];
    r[k] = s;
  }
  if (r[0] <= 1e-12) return null;
  r[0] *= 1.0001;                       // ridge, keeps the recursion stable
  const a = new Float64Array(order + 1), tmp = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    for (let j = 0; j <= i; j++) tmp[j] = a[j];
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    e *= (1 - k * k);
    if (e <= 1e-12) return a;
  }
  return a;
}

/* The LPC envelope is evaluated on a fixed frequency grid every sub-frame, so
   the trig lives in a table built once instead of ~12k calls per sub-frame. */
const ENV_N = 256, ENV_FMAX = 4200, AN_SR = 16000, WIN = 512, LPC_ORDER = 18, SUB_RATE = 100;
const ENV_COS = new Float64Array(ENV_N * (LPC_ORDER + 1));
const ENV_SIN = new Float64Array(ENV_N * (LPC_ORDER + 1));
for (let i = 0; i < ENV_N; i++) {
  const w = 2 * Math.PI * (i * ENV_FMAX / ENV_N) / AN_SR;
  for (let k = 0; k <= LPC_ORDER; k++) {
    ENV_COS[i * (LPC_ORDER + 1) + k] = Math.cos(w * k);
    ENV_SIN[i * (LPC_ORDER + 1) + k] = Math.sin(w * k);
  }
}
const ENV_BUF = new Float64Array(ENV_N);

/** Peak-pick the LPC spectral envelope to get F1 and F2. */
function formants(a) {
  if (!a) return [0, 0];
  const O = LPC_ORDER + 1;
  const env = ENV_BUF;
  for (let i = 0; i < ENV_N; i++) {
    let re = 0, im = 0;
    const base = i * O;
    for (let k = 0; k < O; k++) { const c = a[k]; re += c * ENV_COS[base + k]; im -= c * ENV_SIN[base + k]; }
    env[i] = 1 / Math.sqrt(re * re + im * im + 1e-12);
  }
  let F1 = 0, F2 = 0;
  const hz = ENV_FMAX / ENV_N;
  for (let i = 2; i < ENV_N - 2; i++) {
    if (!(env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > env[i - 2] && env[i] >= env[i + 2])) continue;
    const den = env[i - 1] - 2 * env[i] + env[i + 1];
    const d = den ? (env[i - 1] - env[i + 1]) / (2 * den) : 0;
    const f = (i + d) * hz;
    if (!F1) { if (f >= 180 && f <= 1100) F1 = f; continue; }
    if (!F2 && f >= F1 + 180 && f <= 3200) { F2 = f; break; }
  }
  return [F1, F2];
}

/** Acoustic features at 100 Hz — the rate speech analysis actually needs. The
    output frame rate is a separate, coarser thing; see condense(). */
function* featureStream(mono, srIn) {
  const sig = resample(mono, srIn, AN_SR);
  const hop = AN_SR / SUB_RATE;
  const count = Math.max(1, Math.ceil(sig.length / hop));
  const win = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (WIN - 1));
  const re = new Float64Array(WIN), im = new Float64Array(WIN);
  const seg = new Float64Array(WIN), pre = new Float64Array(WIN);
  const subs = [];
  const binHz = AN_SR / WIN, bins = WIN / 2;

  for (let f = 0; f < count; f++) {
    const start = Math.round(f * hop - WIN / 2);
    let sum = 0, zc = 0, prev = 0;
    for (let i = 0; i < WIN; i++) {
      const idx = start + i;
      const v = (idx >= 0 && idx < sig.length) ? sig[idx] : 0;
      seg[i] = v;
      sum += v * v;
      if (i > 0 && ((v >= 0) !== (prev >= 0))) zc++;
      prev = v;
    }
    const rms = Math.sqrt(sum / WIN);
    const db = 20 * Math.log10(rms + 1e-9);

    if (rms < 6e-4) {                       // below -64 dBFS: nothing to hear
      subs.push({ t: f / SUB_RATE, db, zcr: 0, hiRatio: 0, loRatio: 0, F1: 0, F2: 0, v: 'X', loud: 0 });
    } else {
      for (let i = 0; i < WIN; i++) {
        re[i] = seg[i] * win[i]; im[i] = 0;
        pre[i] = (i === 0 ? seg[0] : seg[i] - 0.97 * seg[i - 1]) * win[i];
      }
      fft(re, im);
      let tot = 0, hi = 0, lo = 0;
      for (let i = 1; i < bins; i++) {
        const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
        const f_ = i * binHz;
        tot += m;
        if (f_ >= 3800) hi += m;
        if (f_ <= 450) lo += m;
      }
      const t2 = tot + 1e-9;
      const [F1, F2] = formants(lpc(pre, LPC_ORDER));
      subs.push({ t: f / SUB_RATE, db, zcr: zc / WIN, hiRatio: hi / t2, loRatio: lo / t2, F1, F2, v: 'X', loud: 0 });
    }

    if ((f & 255) === 255) yield { done: false, progress: f / count, subs };
  }
  yield { done: true, progress: 1, subs };
}

/* --------------------------------------------------------- 3. the classifier */

/** Noise floor = the quiet tenth of the track, so the gate adapts to the room. */
function noiseFloor(frames) {
  const dbs = frames.map(f => f.db).sort((a, b) => a - b);
  return dbs[Math.floor(dbs.length * 0.1)] ?? -60;
}

function classify(frames, cfg) {
  let peak = -120;
  for (const f of frames) if (f.db > peak) peak = f.db;
  // A clean recording can have digitally silent lead-in, which would drag the
  // measured floor to -inf and let every stray sample through. Never trust a
  // floor more than 58 dB under the loudest frame.
  const floor = Math.max(noiseFloor(frames), peak - 58);
  const gate = floor + cfg.gate;
  const span = Math.max(10, peak - gate);

  for (const f of frames) {
    if (f.db < gate) { f.v = 'X'; f.loud = 0; continue; }
    const loud = clamp((f.db - gate) / span, 0, 1);
    f.loud = loud;

    // Unvoiced fricatives read off the high band before we ever look at vowels.
    if (f.hiRatio > 0.40 && f.zcr > 0.16) { f.v = 'B'; continue; }           // S SH T K
    if (f.hiRatio > 0.22 && f.zcr > 0.14 && f.loRatio < 0.35 && loud < 0.45) {
      f.v = 'G'; continue;                                                    // F V TH
    }
    if (loud < 0.13 && f.loRatio > 0.55) { f.v = 'A'; continue; }             // M B P closure

    const F1 = f.F1 / cfg.vs, F2 = f.F2 / cfg.vs;
    if (!F1 || !F2) { f.v = loud > 0.45 ? 'C' : 'B'; continue; }

    // F1 tracks jaw opening, F2 tracks front/back. Read them in that order:
    // how far the mouth is open matters more on screen than where the tongue is.
    let v;
    if (F1 >= 620) v = 'D';                                   // AA AE — wide open
    else if (F1 >= 470) v = F2 > 1650 ? 'C' : 'E';            // EH / AO ER
    else if (F2 > 1750) v = 'B';                              // EE IH — spread
    else if (F2 < 1500) v = 'F';                              // OO UW W — pucker
    else v = cfg.detectL ? 'H' : 'E';                         // close and central

    if (v === 'C' && loud > 0.82) v = 'D';                    // shouting opens up
    if (v === 'D' && loud < 0.28) v = 'C';                    // muttering doesn't
    f.v = v;
  }
  return frames;
}

/** Absorb runs shorter than minHold, then set closures going into pauses. */
function smooth(frames, cfg) {
  const n = frames.length;
  if (!n) return frames;
  const hold = cfg.hold;

  for (let pass = 0; pass < 2 && hold > 1; pass++) {
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n && frames[j].v === frames[i].v) j++;
      const len = j - i;
      if (len < hold && !(frames[i].v === 'X')) {
        const before = i > 0 ? frames[i - 1].v : null;
        const after = j < n ? frames[j].v : null;
        let lenB = 0, lenA = 0;
        for (let k = i - 1; k >= 0 && frames[k].v === before; k--) lenB++;
        for (let k = j; k < n && frames[k].v === after; k++) lenA++;
        const win = (lenB >= lenA ? before : after) ?? before ?? after;
        if (win) for (let k = i; k < j; k++) frames[k].v = win;
      }
      i = j;
    }
  }

  if (cfg.closures) {
    for (let i = 1; i < n; i++) {
      if (frames[i].v === 'X' && frames[i - 1].v !== 'X' && frames[i - 1].v !== 'A') {
        let run = 0;
        for (let k = i; k < n && frames[k].v === 'X'; k++) run++;
        if (run >= 3) frames[i - 1].v = 'A';
      }
    }
  }
  return frames;
}

/** Collapse 100 Hz sub-frames onto the output frame rate. A drawn frame holds
    for its whole duration, so it should show the sound that dominates it —
    weighted by loudness, with silence counting for less than speech. */
function condense(subs, fps) {
  const n = Math.max(1, Math.round(subs.length / SUB_RATE * fps));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * SUB_RATE / fps);
    const b = Math.max(a + 1, Math.floor((i + 1) * SUB_RATE / fps));
    const score = Object.create(null);
    let db = -180, F1 = 0, F2 = 0, wsum = 0, loud = 0;
    for (let k = a; k < b && k < subs.length; k++) {
      const s = subs[k];
      const w = s.v === 'X' ? 0.35 : 0.25 + s.loud;
      score[s.v] = (score[s.v] || 0) + w;
      if (s.db > db) db = s.db;
      if (s.loud > loud) loud = s.loud;
      if (s.v !== 'X' && s.F1) { F1 += s.F1 * s.loud; F2 += s.F2 * s.loud; wsum += s.loud; }
    }
    let best = 'X', bestS = -1;
    for (const v in score) if (score[v] > bestS) { bestS = score[v]; best = v; }
    out.push({
      t: i / fps, v: best, db, loud,
      F1: wsum ? F1 / wsum : 0, F2: wsum ? F2 / wsum : 0, edited: false
    });
  }
  return out;
}

/* --------------------------------------------------------- 4. engine registry

   An engine is one async function:

     run(mono, sampleRate, fps, cfg, onProgress) -> Promise<frames>
       frames: [{t, v, edited, ...}], one per output frame

   Everything downstream — the renderer, the exposure sheet, the exporters —
   only ever sees that array, which is why a second engine could be dropped in
   without touching any of it.
------------------------------------------------------------------------------ */

function toPCM16(mono, srIn) {
  const sig = resample(mono, srIn, 16000);
  const pcm = new Int16Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i] * 32767;
    pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return pcm;
}

/** Sample Rhubarb's [{start,end,value}] cue list onto the output frame grid. */
function cuesToFrames(cues, fps, duration) {
  const n = Math.max(1, Math.round(duration * fps));
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: i / fps, v: 'X', db: 0, loud: 0, F1: 0, F2: 0, edited: false });
  for (const c of cues) {
    const a = clamp(Math.floor(c.start * fps), 0, n - 1);
    const b = clamp(Math.ceil(c.end * fps), 0, n);
    for (let i = a; i < b; i++) if (VIS.includes(c.value)) out[i].v = c.value;
  }
  return out;
}

/** Rhubarb has no silence gate of its own — with room tone on the tail it will
    keep animating through it. Measuring frame energy here is cheap (no FFT, no
    LPC) and lets the same gate slider govern both engines. */
function applyGate(frames, mono, srIn, fps, cfg) {
  const sig = resample(mono, srIn, AN_SR);
  const hop = AN_SR / fps, win = Math.round(AN_SR * 0.032);
  const dbs = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const start = Math.round(i * hop - win / 2);
    let sum = 0;
    for (let k = 0; k < win; k++) {
      const idx = start + k;
      const v = (idx >= 0 && idx < sig.length) ? sig[idx] : 0;
      sum += v * v;
    }
    dbs[i] = 20 * Math.log10(Math.sqrt(sum / win) + 1e-9);
  }
  let peak = -120;
  for (const d of dbs) if (d > peak) peak = d;
  const sorted = Array.from(dbs).sort((a, b) => a - b);
  const floor = Math.max(sorted[Math.floor(sorted.length * 0.1)] ?? -60, peak - 58);
  const gate = floor + cfg.gate;
  for (let i = 0; i < frames.length; i++) {
    frames[i].db = dbs[i];
    if (dbs[i] < gate) frames[i].v = 'X';
  }
  return frames;
}

/* ---- the embedded Rhubarb build ---- */

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot inflate the embedded model (no DecompressionStream).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const WORKER_BOOT = `
let M = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      M = await createLipSyncEngineModule({
        wasmBinary: m.wasm,
        getPreloadedPackage: () => m.data,
        print: () => {}, printErr: () => {}
      });
      const p = '/wasm/res', len = M.lengthBytesUTF8(p) + 1, ptr = M._malloc(len);
      M.stringToUTF8(p, ptr, len);
      const rc = M._lipsyncengine_init(ptr);
      M._free(ptr);
      if (rc !== 0) {
        const ep = M._lipsyncengine_get_last_error();
        throw new Error(ep ? M.UTF8ToString(ep) : 'init returned ' + rc);
      }
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'analyze') {
      const pcm = m.pcm, ptr = M._malloc(pcm.length * 2);
      M.HEAP16.set(pcm, ptr >> 1);
      const res = M._lipsyncengine_analyze_pcm16(ptr, pcm.length, 16000, 0);
      M._free(ptr);
      if (!res) {
        const ep = M._lipsyncengine_get_last_error();
        throw new Error(ep ? M.UTF8ToString(ep) : 'analysis failed');
      }
      const json = M.UTF8ToString(res);
      M._lipsyncengine_free(res);
      self.postMessage({ type: 'cues', json });
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
};
`;

const rhubarb = {
  get embedded() { return typeof window !== 'undefined' && !!window.RHUBARB_PAYLOAD; },
  mode: null, worker: null, module: null, booting: null,

  async ensure(status) {
    if (this.module || this.worker) return;
    if (this.booting) return this.booting;
    this.booting = (async () => {
      const P = window.RHUBARB_PAYLOAD;
      if (!P) throw new Error('This build does not embed Rhubarb.');
      status && status('Inflating the acoustic model…');
      const [data, wasm] = await Promise.all([gunzipB64(P.dataGz), gunzipB64(P.wasmGz)]);

      // A worker keeps a long recognition off the main thread. The glue is
      // concatenated into the worker's own blob rather than pulled in with
      // importScripts: on a file:// page the blob URL has a null origin and
      // that nested fetch is refused, which would strand every local copy on
      // the main thread.
      try {
        status && status('Starting the recogniser…');
        const w = new Worker(URL.createObjectURL(
          new Blob([P.glue, '\n', WORKER_BOOT], { type: 'text/javascript' })));
        await new Promise((res, rej) => {
          const to = setTimeout(() => rej(new Error('worker init timed out')), 60000);
          w.onmessage = e => {
            if (e.data.type === 'ready') { clearTimeout(to); res(); }
            else if (e.data.type === 'error') { clearTimeout(to); rej(new Error(e.data.error)); }
          };
          w.onerror = err => { clearTimeout(to); rej(new Error(err.message || 'worker failed')); };
          w.postMessage({ type: 'init', data: data.buffer, wasm: wasm.buffer });
        });
        this.worker = w;
        this.mode = 'worker';
        return;
      } catch (e) {
        console.warn('Rhubarb worker unavailable, running on the main thread:', e);
      }

      status && status('Starting the recogniser…');
      if (typeof createLipSyncEngineModule !== 'function') {
        const s = document.createElement('script');
        s.textContent = P.glue;
        document.head.appendChild(s);
      }
      if (typeof createLipSyncEngineModule !== 'function') throw new Error('Rhubarb module failed to load.');
      const M = await createLipSyncEngineModule({
        wasmBinary: wasm.buffer,
        getPreloadedPackage: () => data.buffer,
        print: () => {}, printErr: () => {}
      });
      const p = '/wasm/res', len = M.lengthBytesUTF8(p) + 1, ptr = M._malloc(len);
      M.stringToUTF8(p, ptr, len);
      const rc = M._lipsyncengine_init(ptr);
      M._free(ptr);
      if (rc !== 0) throw new Error('Rhubarb could not load its models.');
      this.module = M;
      this.mode = 'main';
    })();
    try { await this.booting; } finally { this.booting = null; }
  },

  /** In a worker the whole file goes at once, which is what Rhubarb expects.
      On the main thread — where some browsers strand us for file:// pages — a
      long take is split so the page keeps painting between chunks. Seams cost
      a little accuracy; a ten-second freeze costs more. */
  async analyzeIn(pcm, seconds, onProgress) {
    const CHUNK = 16000 * 20;
    if (this.mode === 'worker' || seconds <= 30 || pcm.length <= CHUNK * 1.5) {
      return this.analyze(pcm);
    }
    const cues = [];
    const total = Math.ceil(pcm.length / CHUNK);
    for (let i = 0, off = 0; off < pcm.length; i++) {
      const end = Math.min(pcm.length, off + CHUNK);
      const t0 = off / 16000;
      for (const c of await this.analyze(pcm.slice(off, end))) {
        cues.push({ start: c.start + t0, end: c.end + t0, value: c.value });
      }
      off = end;
      onProgress && onProgress((i + 1) / total);
      await new Promise(r => requestAnimationFrame(r));
    }
    return cues;
  },

  async analyze(pcm) {
    if (this.worker) {
      return new Promise((res, rej) => {
        this.worker.onmessage = e => {
          if (e.data.type === 'cues') res(JSON.parse(e.data.json).mouthCues || []);
          else if (e.data.type === 'error') rej(new Error(e.data.error));
        };
        this.worker.postMessage({ type: 'analyze', pcm }, [pcm.buffer]);
      });
    }
    const M = this.module;
    const ptr = M._malloc(pcm.length * 2);
    M.HEAP16.set(pcm, ptr >> 1);
    const res = M._lipsyncengine_analyze_pcm16(ptr, pcm.length, 16000, 0);
    M._free(ptr);
    if (!res) {
      const ep = M._lipsyncengine_get_last_error();
      throw new Error(ep ? M.UTF8ToString(ep) : 'analysis failed');
    }
    const json = M.UTF8ToString(res);
    M._lipsyncengine_free(res);
    return JSON.parse(json).mouthCues || [];
  }
};

const ENGINES = {
  dsp: {
    label: 'Built-in DSP',
    note: 'Formant analysis written from scratch. Instant, tunable, and it uses the whole A–H chart.',
    available: () => true,
    run(mono, sr, fps, cfg, onProgress) {
      return new Promise((resolve, reject) => {
        const gen = featureStream(mono, sr);
        const pump = () => {
          const t0 = performance.now();
          let step;
          do { step = gen.next().value; } while (step && !step.done && performance.now() - t0 < 24);
          if (!step) return reject(new Error('analysis ended unexpectedly'));
          onProgress(step.progress * 0.95);
          if (!step.done) return requestAnimationFrame(pump);
          classify(step.subs, cfg);
          onProgress(1);
          resolve(smooth(condense(step.subs, fps), cfg));
        };
        requestAnimationFrame(pump);
      });
    }
  },
  rhubarb: {
    label: 'Rhubarb',
    note: 'Rhubarb Lip Sync itself, compiled to WebAssembly and embedded in this file. Stronger on consonants. Takes about a second per eight seconds of audio, and animates on the basic A–F set.',
    available: () => rhubarb.embedded,
    async run(mono, sr, fps, cfg, onProgress, status) {
      onProgress(0.04);
      await rhubarb.ensure(status);
      onProgress(0.3);
      const seconds = mono.length / sr;
      status && status(rhubarb.mode === 'worker' ? 'Recognising phones…' : 'Recognising phones (this holds the page)…');
      const cues = await rhubarb.analyzeIn(toPCM16(mono, sr), seconds, p => onProgress(0.3 + p * 0.65));
      onProgress(0.95);
      // Rhubarb has done its own phone timing; the silence gate, minimum hold
      // and closures are still the user's to set.
      const frames = applyGate(cuesToFrames(cues, fps, mono.length / sr), mono, sr, fps, cfg);
      return smooth(frames, { hold: cfg.hold, closures: cfg.closures });
    }
  }
};
let engine = 'dsp';

/* ------------------------------------------------------- 5. mouth rendering */

/* --- the three views ------------------------------------------------------

   A mouth chart belongs to a head angle. The same nine shapes drawn for a
   character facing the camera are wrong on a character in three-quarter, and
   wronger still in profile, which is why traditional rigs carry a set per view.

   What is NOT done here: taking the front drawing and squashing it. In-plane
   rotation and a horizontal scale give you a front-on mouth at an angle, which
   reads as a sticker. The geometry is rebuilt per view instead, from the same
   per-viseme parameters, so all fifteen styles get a real turn for free — every
   one of them draws from what geom() returns.

   The character faces the viewer's RIGHT in both turned views: the front of the
   mouth is to the right, the corner that wraps around the cheek to the left.
--------------------------------------------------------------------------- */
const VIEWS = {
  front:   { label: 'Front', turn: 0 },
  three:   { label: 'Three-quarter', turn: 35 },
  profile: { label: 'Profile', turn: 90 }
};

/** The aperture, front-on or three-quarter. Asymmetric half-widths: on a turned
    head the far half foreshortens more than the near half, and that difference
    is most of what makes a turn read as a turn rather than as a narrow mouth. */
function outline(cx, cy, hwL, hwR, up, dn, round) {
  const kL = hwL * (0.50 + 0.42 * round), kR = hwR * (0.50 + 0.42 * round);
  const dip = up * 0.16;
  // The peak of the upper lip sits over the middle of the APERTURE, which on a
  // turned head is not the middle of the two corners.
  const px = cx + (hwR - hwL) * 0.30;
  // The far corner rides up and tucks as the mouth wraps the cheek.
  const lift = (hwR - hwL) * 0.13;
  const p = new Path2D();
  p.moveTo(cx - hwL, cy - lift);
  p.bezierCurveTo(cx - kL, cy - up * 1.22 - lift, px - kL * 0.34, cy - up + dip, px, cy - up + dip);
  p.bezierCurveTo(px + kR * 0.34, cy - up + dip, cx + kR, cy - up * 1.22, cx + hwR, cy);
  p.bezierCurveTo(cx + kR, cy + dn * 1.26, cx - kL, cy + dn * 1.26 - lift, cx - hwL, cy - lift);
  p.closePath();
  return p;
}

/* --- the profile primitives ------------------------------------------------

   A lip seen from the side is built the opposite way round from a lip seen
   from the front. Front-on it is fullest in the middle and dies away to both
   corners. From the side you are looking along it: the near corner is right in
   front of you as a point where the lip runs out into the cheek, and the whole
   mass of the lip is at the FRONT, where the vermilion turns over. So the lobe
   is a wedge — nothing at the back, full at the front, with a rounded free edge.

   Both lips are built by the same function. What tells them apart is which way
   they point, how far forward the free edge reaches, and how much of the
   opening each one is carrying.
--------------------------------------------------------------------------- */

/** Where the free edge of a lip turns back on itself, given how pursed it is.
    Kept in one place because the cavity has to end exactly where the lip does,
    or a hairline of background shows through between them. */
const lipFreeX = (tipX, body, roll) => tipX - body * (0.16 + roll * 0.46);

/** One lip in profile, from the mouth corner (bx, by) out to a free edge at
    (tipX, tipY).
      sign  -1 for the upper lip, +1 for the lower — which side the body is on
      body  the lip's own thickness at the front
      roll  0 slack, 1 pursed — how far the free edge curls back under itself */
/* --- the two lips are not each other's mirror -------------------------------

   This was the mistake that kept the side view reading as a beak. Both lips
   were the same crescent, one flipped, so the silhouette came out symmetric
   about the mouth line — and a symmetric shape says "hole" rather than "face".

   A profile mouth is lopsided in three ways at once, and every drawn reference
   has all three:

     - The UPPER lip is the smaller of the two, and its outer edge RISES toward
       the front into the philtrum rather than doming over the middle. That rise
       is the single most face-like mark in the whole drawing.
     - The LOWER lip is fuller, sits a little further back, and its outer edge
       sweeps down and BACK toward the chin, with a shallow hollow behind the
       vermilion where the labiomental crease is.
     - The front-most point belongs to the upper lip.

   So they are drawn by two functions rather than one with a sign flipped.
--------------------------------------------------------------------------- */

/** How thick a lip has to be drawn to LOOK the thickness it was given. `body`
    is a vertical figure, but on an open shape the lip climbs steeply from a
    dropped corner, and the same vertical measure buys a much thinner lip. */
const lipBody = (body, dy, L) => body * Math.hypot(1, dy / Math.max(1, L));

/** How much of its thickness a lip still has where it runs off into the cheek.
    Not zero: see the note in profileUpperLip. */
const BUTT = 0.46;

function profileUpperLip(bx, by, tipX, tipY, body0, roll, edge) {
  const L = Math.max(1, tipX - bx);
  const t = lipBody(body0, tipY - by, L);
  const p = new Path2D();
  // The back end is BLUNT, not a point. Both lips used to converge on the corner
  // and the silhouette came to a needle, which is exactly what a beak is. A real
  // mouth corner does not taper away in view — it runs into the cheek and is
  // simply hidden, so the drawing should stop rather than sharpen. closePath()
  // walks the short vertical face back from the inner edge at (bx, by).
  p.moveTo(bx, by - t * BUTT);
  // Out of the corner, then the philtrum: the top edge keeps climbing right up
  // to the front instead of arching over the middle. Rounded over rather than
  // peaked — a spike at the top front reads as a snout.
  p.bezierCurveTo(bx + L * 0.34, by - t * 0.96,
                  bx + L * 0.70, tipY - t * 1.02,
                  tipX - t * 0.40, tipY - t * 1.12);
  // Over the tubercle and down to the free edge. This is the forward-most point
  // of the whole mouth.
  p.bezierCurveTo(tipX + t * 0.32, tipY - t * 0.82,
                  tipX + t * 0.30, tipY - t * 0.10,
                  edge ? edge.fx : lipFreeX(tipX, t, roll), tipY);
  // Back along the roof of the mouth. Where there is a cavity the caller hands
  // over its own edge, control point for control point: a lip drawn to its own
  // idea of where the opening is leaves a hairline of daylight between the two,
  // and a hairline across every open shape is not a detail.
  if (edge) p.bezierCurveTo(edge.c1x, edge.c1y, edge.c2x, edge.c2y, bx, by);
  else p.bezierCurveTo(bx + L * 0.60, tipY + (by - tipY) * 0.04,
                       bx + L * 0.24, by + (tipY - by) * 0.46, bx, by);
  p.closePath();
  return p;
}

function profileLowerLip(bx, by, tipX, tipY, body0, roll, edge) {
  const L = Math.max(1, tipX - bx);
  const t = lipBody(body0, tipY - by, L) * 1.10;   // the fuller of the two
  const p = new Path2D();
  p.moveTo(bx, by);
  // Along the floor to the free edge first, so the outer sweep can be walked
  // back afterwards — it is the longer and more shaped of the two edges.
  if (edge) {
    p.bezierCurveTo(edge.c2x, edge.c2y, edge.c1x, edge.c1y, edge.fx, tipY);
  } else {
    p.bezierCurveTo(bx + L * 0.24, by + (tipY - by) * 0.46,
                    bx + L * 0.60, tipY + (by - tipY) * 0.04, tipX, tipY);
  }
  // Over the vermilion, which protrudes but stops short of the upper lip.
  p.bezierCurveTo(tipX + t * 0.24, tipY + t * 0.20,
                  tipX + t * 0.12, tipY + t * 0.70,
                  tipX - t * 0.62, tipY + t * 0.88);
  // Then the hollow of the labiomental crease, and back into the chin. Back
  // rather than down: a lower lip that drops straight off the vermilion is a
  // blob, and what makes it a chin is the long shallow run to the corner.
  // It stops blunt, like the upper one.
  p.bezierCurveTo(bx + L * 0.66, tipY + t * 0.60,
                  bx + L * 0.30, by + t * 0.82,
                  bx, by + t * BUTT);
  p.closePath();
  return p;
}

/** Kept for the bite shape, which needs a plain lip with no philtrum on it. */
function profileLobe(bx, by, tipX, tipY, sign, body0, roll, edge) {
  return sign < 0
    ? profileUpperLip(bx, by, tipX, tipY, body0, roll, edge)
    : profileLowerLip(bx, by, tipX, tipY, body0, roll, edge);
}

/** The dark between the lips. Not a hole — that is the whole point. Front-on
    the opening is a closed ring of lip; from the side the gap runs clean out of
    the face, so the shape is a wedge with its apex at the mouth corner and an
    open mouth at the front. Both edges are the inside edges of the two lobes,
    expression for expression, so no hairline of background can show between. */
/** The corners of the wedge, shared by the cavity and by the roof of the mouth
    that the teeth hang from — they have to agree to the last control point or
    the teeth show as a pale stripe floating in the dark. */
function profileWedge(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, roll, frontPad) {
  const fu = lipFreeX(tipU, bodyU, roll), fl = lipFreeX(tipL, bodyL, roll);
  // A pursed mouth does not open along its whole length: the lips gather into
  // a cone and the hole is a small round one right at the front. So the apex of
  // the wedge travels forward with the purse, while the lips themselves still
  // run back to the corner. Leave the apex at the corner and "oo" comes out as
  // a narrow "oh" — which was the one shape nobody could tell apart.
  const t = roll * 0.62;
  const ax = bx + ((fu + fl) * 0.5 - bx) * t;
  const ay = by + ((uy + ly) * 0.5 - by) * t;
  const LU = Math.max(1, fu - ax), LL = Math.max(1, fl - ax);
  return {
    fu, fl, ax, ay, LU, LL,
    front: Math.max(fu, fl) + (bodyU + bodyL) * (frontPad == null ? 0.06 : frontPad),
    // the same two edges again, walked from the front back to the corner, for
    // the lips to close on exactly
    roofBack: { fx: fu, c1x: ax + LU * 0.62, c1y: uy + (ay - uy) * 0.04,
                c2x: ax + LU * 0.16, c2y: ay + (uy - ay) * 0.14 },
    floorBack: { fx: fl, c1x: ax + LL * 0.62, c1y: ly + (ay - ly) * 0.04,
                 c2x: ax + LL * 0.16, c2y: ay + (ly - ay) * 0.14 }
  };
}

/** The roof of the mouth, from the corner forward to the upper lip's free edge.
    Offset vertically by `drop` it is still exact, which is what the tooth band
    is built from. */
function profileRoof(path, bx, by, uy, w, drop) {
  path.moveTo(bx, by + drop);
  path.bezierCurveTo(w.ax + w.LU * 0.16, w.ay + (uy - w.ay) * 0.14 + drop,
                     w.ax + w.LU * 0.62, uy + (w.ay - uy) * 0.04 + drop,
                     w.fu, uy + drop);
}

/** And the floor, from the corner forward to the lower lip's free edge. Same
    construction as the roof, so the lower tooth row can be built off it the
    same way. */
function profileFloor(path, bx, by, ly, w, rise) {
  path.moveTo(bx, by + rise);
  path.bezierCurveTo(w.ax + w.LL * 0.16, w.ay + (ly - w.ay) * 0.14 + rise,
                     w.ax + w.LL * 0.62, ly + (w.ay - ly) * 0.04 + rise,
                     w.fl, ly + rise);
}

/* --- one ring, not two flaps ------------------------------------------------

   Two separately sculpted lobes was the wrong idea, and it took a long time to
   see why. Drawn apart they stop being a mouth and become a pair of crescents
   hinged at a point — a beak, or a crab's claw, depending on how far they were
   pushed. Nothing in the tuning fixes that, because the fault is that there are
   two shapes where the eye wants one.

   Front-on, every style here draws a RING of lip around a dark aperture, and
   that is what makes the fifteen of them read as one set. The side view is the
   same thing foreshortened: the aperture loses its far corner and becomes a
   wedge, wide at the front and running to a point where the cheek takes over,
   and the lips are that same wedge grown outward. Built that way the profile
   stops being its own invention and becomes the front view turned, which is
   all it ever needed to be.

   The overbite survives as the one asymmetry worth keeping: the upper lip is
   grown further forward than the lower, so the leading edge steps back as it
   comes down. That is the silhouette cue that says "side of a face", and it
   costs one number rather than a second shape.
--------------------------------------------------------------------------- */
function profileRim(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, roll) {
  // The purse is deliberately almost absent here. Inside, a pucker gathers the
  // opening into a small hole up at the front, and the wedge's apex travels
  // forward to say so. The OUTSIDE of the lips does no such thing — it still
  // runs back to the corner — and letting the apex travel on the rim as well
  // scooped the top edge out and left a long tail behind it: a fang, not a
  // mouth.
  // The forward numbers used to be 0.78 and 0.30, which grew the lips a whole
  // body-thickness PAST the front of the opening. Seen side on that is a slab
  // of lip colour across the leading edge, and it is the thing that made these
  // read as a coloured wedge rather than as a mouth: at the front of a real
  // profile the first thing you see is TEETH, with the lips as thin tips above
  // and below them. So the rim now barely clears the cavity at the front, and
  // keeps its thickness where a lip actually has it — above and below.
  return profileCavity(bx - (bodyU + bodyL) * 0.26, by,
                       tipU + bodyU * 0.10, uy - bodyU,
                       tipL + bodyL * 0.04, ly + bodyL,
                       bodyU, bodyL, roll * 0.20, 0.07);
}

/** `frontPad` is how far the leading edge bows out past the lips' free edges,
    in body-thicknesses. It used to be a fixed 0.16 for both the cavity and the
    rim grown from it, and because the rim spans a taller gap than the cavity
    does, the same bow drawn across a taller span swells into a thick arc —
    which is the lip-coloured slab that sat across the front of every open
    shape. Small numbers here, and a little larger for the rim than the cavity,
    give what the drawn references have: a nearly upright leading edge, teeth
    reaching it, and the lips as thin tips above and below. */
function profileCavity(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, roll, frontPad) {
  const w = profileWedge(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, roll,
                         frontPad == null ? 0.06 : frontPad);
  const p = new Path2D();
  // Still anchored at the corner — the lips run back to it whatever the purse,
  // and a cavity that started at the apex left a sliver of daylight between
  // the two lobes where nothing was drawn at all.
  profileRoof(p, bx, by, uy, w, 0);
  p.bezierCurveTo(w.front, uy + (ly - uy) * 0.34, w.front, ly - (ly - uy) * 0.34, w.fl, ly);
  p.bezierCurveTo(w.ax + w.LL * 0.62, ly + (w.ay - ly) * 0.04,
                  w.ax + w.LL * 0.16, w.ay + (ly - w.ay) * 0.14, bx, by);
  p.closePath();
  return p;
}

/* --- what is actually inside a mouth seen from the side ---------------------

   This got the wrong way round first time. The opening was filled dark with a
   thin band of teeth laid along the top, which makes a black bubble with a
   highlight on it — realistic enough, and it reads as a hole in a face rather
   than as a face talking.

   Every drawn reference does the opposite, and they are right: from the side
   you are looking at TEETH. Two rows of them, hanging off the roof and standing
   on the floor, taking most of the height of the opening at the front. The dark
   is what shows between them and, more importantly, BEHIND them — the throat,
   deep in, where the teeth have run out. So the dark reads as a slot through
   the middle widening to a pocket at the back, and the white is the mass. That
   one inversion is most of the difference between the two drawings.
--------------------------------------------------------------------------- */

/** A tooth row hung off the roof (`sign` -1) or standing on the floor (+1).

    The free edge runs from nothing at the mouth corner to its full depth at the
    front, so the row is a crescent rather than a band. That shape is doing two
    jobs: it puts the white where the teeth actually are, and it leaves the dark
    between the two rows as a lens that is widest where the lips part — which is
    where the eye expects the opening to be.

    An earlier version ran both rows at constant depth and chopped them off at
    the back with a rectangle. The chop showed: a hard vertical edge across the
    middle of the drawing, and at small sizes it read as a shard of glass in the
    mouth rather than as teeth. */
function profileTeeth(bx, by, edgeY, w, th, sign) {
  const p = new Path2D();
  const L = sign < 0 ? w.LU : w.LL;
  const fx = sign < 0 ? w.fu : w.fl;
  if (sign < 0) profileRoof(p, bx, by, edgeY, w, 0);
  else profileFloor(p, bx, by, edgeY, w, 0);
  p.lineTo(fx, edgeY - sign * th);
  p.bezierCurveTo(w.ax + L * 0.66, edgeY + (w.ay - edgeY) * 0.10 - sign * th * 0.86,
                  w.ax + L * 0.24, w.ay + (edgeY - w.ay) * 0.20 - sign * th * 0.34,
                  bx, by);
  p.closePath();
  return p;
}

/** The line where the lips meet, from the corner out to the front. A shut
    profile mouth without it is a featureless lump; it is doing the job the
    aperture does in every other view. */
function profileSeam(bx, by, tipU, tipL, bodyU, roll) {
  const fx = lipFreeX((tipU + tipL) * 0.5, bodyU, roll);
  const L = Math.max(1, fx - bx);
  const p = new Path2D();
  p.moveTo(bx, by);
  p.bezierCurveTo(bx + L * 0.42, by + L * 0.055, bx + L * 0.78, by + L * 0.045, fx, by - L * 0.02);
  return p;
}

function geom(v, W, H, C) {
  const p = VP[v];
  const mw = (C && C.widthMul) || 1, mh = (C && C.heightMul) || 1;
  const view = (C && C.view) || 'front';
  const cy = H * 0.56;
  const half = p.w * mw * W / 2;
  const up = p.h * mh * W * 0.40, dn = p.h * mh * W * 0.60;

  if (view === 'profile') {
    const r = p.round;
    // Width stops meaning "how wide the mouth is" and starts meaning "how far
    // the lips stick out". A pucker protrudes hard and draws its corner in; a
    // wide "aa" barely protrudes at all, it just drops the jaw. That swap is
    // the whole difference between a side view and a narrow front one.
    // The opening. Seen from the side the JAW does nearly all of it — the upper
    // lip hardly moves — except on a pucker, where the lips do the work
    // themselves and the two halves share it evenly. Front-on the split is
    // always even, and keeping that even split here was what made an open shape
    // read as a tall slab instead of a jaw coming down.
    // A pucker also makes a SMALL hole, however far the lips travel to make it.
    // Far smaller than the front view's opening, and deliberately. Seen from
    // the side a mouth is mostly LIP: the drawn references all put the flesh as
    // the mass and the opening as a slot through it, and the first several goes
    // at this had it the other way round — a big dark aperture with two thin
    // rims, which is the "black bubble" it kept reading as.
    const gap = p.h * mh * W * (1.00 - 0.28 * p.h) * (1 - 0.34 * r) * 1.00;
    // Almost all of it belongs to the jaw. An even split draws a symmetrical V
    // hinged at the corner — scissors, not a face. What says "side of a head" is
    // an upper lip that stays put while the chin swings away from it. Only a
    // pucker shares the work, because there the lips do it rather than the jaw.
    const jawUp = gap * (0.08 + 0.34 * r);
    const jawDn = gap - jawUp;
    // A jaw is not hinged at the mouth corner: it pivots behind the ear, so as
    // it drops the corner travels down as well, about a third as far as the
    // front. Leave the corner on the mouth line and the opening has to be a
    // near-vertical wall where it meets the cheek — which is what made the
    // first construction read as a triangle standing on its point.
    const drop = jawDn * 0.20;
    // Corner and front both move back as the mouth opens: the lips are drawn
    // thin over the teeth and the whole of it is deeper than a shut mouth.
    const grow = 1 + 0.52 * p.h * mh;
    // How much of the mouth's LENGTH is visible from the side — and the answer
    // is: very little. The corner is nearly edge-on and the cheek covers most
    // of the run back to it, so what shows is close to a cross-section of the
    // lips. Drawing the corner where it really is, a quarter of a head-width
    // back, gives a long tapered arrowhead: correct in plan, wrong in view, and
    // it was the single thing making these read as something other than lips.
    // A pucker gathers its corners in as well as pushing its lips out, so it
    // gets shorter and deeper at once.
    // Longer than it was. A profile mouth is wider than it is tall — every
    // drawn reference is a tapered arrowhead — and at 0.090 the corner sat so
    // close to the front that an open shape came out taller than it was long,
    // which is a wedge standing on its point rather than a mouth on a face.
    const back = W * (0.112 + 0.072 * (1 - r)) * mw * grow;
    const fwd  = W * (0.050 + 0.120 * r) * mw;
    const cx = W / 2 - (fwd - back) * 0.5;        // balance the drawing in the tile
    const hw = (back + fwd) / 2;
    // `build` is the padded silhouette the lipped renderer asks for front-on.
    // In profile the lips are drawn lobe by lobe instead, so what comes back
    // here is only ever used as a bounding shape.
    const build = (padW, padU, padD) =>
      profileCavity(cx - back, cy + drop, cx + fwd + padW, cy - jawUp - padU,
                    cx + fwd + padW, cy + jawDn + padD, padW, padW, r);
    return { p, view, cx, cy, hw, hwL: back, hwR: fwd, up: jawUp, dn: jawDn, drop,
             path: build(0, 0, 0), build };
  }

  if (view === 'three') {
    const t = VIEWS.three.turn * Math.PI / 180;
    const c = Math.cos(t);                        // 0.819 at 35°
    // The near half keeps almost its width; the far half loses a third again to
    // the curve of the cheek. 0.86 / 0.60 of the front width.
    // Measured by eye rather than by trigonometry alone: cos 35° alone gives a
    // mouth that is merely narrower. What reads as a turn is the LOPSIDEDNESS —
    // the near half keeping nearly its full width while the far half is eaten
    // by the curve of the cheek.
    const hwR = half * c * 1.16, hwL = half * c * 0.52;
    const cx = W / 2 + half * 0.09;
    const hw = (hwL + hwR) / 2;
    const build = (padW, padU, padD) =>
      outline(cx, cy, hwL + padW * 0.86, hwR + padW, up + padU, dn + padD, p.round);
    return { p, view, cx, cy, hw, hwL, hwR, up, dn, tilt: -0.075,
             path: build(0, 0, 0), build };
  }

  const cx = W / 2;
  const hw = half;
  const build = (padW, padU, padD) =>
    outline(cx, cy, hw + padW, hw + padW, up + padU, dn + padD, p.round);
  return { p, view, cx, cy, hw, hwL: hw, hwR: hw, up, dn,
           path: build(0, 0, 0), build };
}

function fillCavity(ctx, g, color) { ctx.fillStyle = color; ctx.fill(g.path); }

/** A row of teeth. Flat by default; `scallop` gives the free edge a bump per
    tooth, which is the difference between a cartoon smile and a white stripe.
    `down` says which edge is free — the upper row hangs, the lower row sits. */
function toothBand(ctx, x0, x1, y, h, col, scallop, down) {
  ctx.fillStyle = col;
  const w = x1 - x0;
  if (!scallop || w < 8 || h < 3) { ctx.fillRect(x0, y, w, h); return; }
  const n = Math.max(2, Math.round(w / Math.max(6, Math.min(h * 1.7, w / 3))));
  const t = w / n, r = t * 0.5;
  ctx.beginPath();
  if (down) {
    ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.lineTo(x1, y + h - r);
    for (let i = n - 1; i >= 0; i--) ctx.arc(x0 + t * (i + 0.5), y + h - r, r, 0, Math.PI, false);
  } else {
    ctx.moveTo(x0, y + h); ctx.lineTo(x1, y + h); ctx.lineTo(x1, y + r);
    for (let i = n - 1; i >= 0; i--) ctx.arc(x0 + t * (i + 0.5), y + r, r, 0, Math.PI, true);
  }
  ctx.closePath();
  ctx.fill();
}

function innards(ctx, g, W, C) {
  const { p, cx, cy, hw, up, dn } = g;
  const hwL = g.hwL == null ? hw : g.hwL, hwR = g.hwR == null ? hw : g.hwR;
  const mul = C.teethMul || 1;
  ctx.save(); ctx.clip(g.path);
  if (p.tongue > 0.02 && dn > W * 0.02) {
    const tm = C.tongueMul || 1;
    ctx.fillStyle = C.tongue;
    ctx.beginPath();
    // The tongue sits toward the back of the mouth, which on a turned head is
    // not the middle of the aperture.
    ctx.ellipse(cx + (hwR - hwL) * 0.10, cy + dn * 0.66, hw * 0.66 * tm,
                Math.max(2, dn * 0.52 * p.tongue * tm), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (p.teeth > 0.02 && up > W * 0.008) {
    const th = Math.min(up * 1.05, W * 0.062) * mul;
    // `teethFloor` lifts the whole range for a style that wants white teeth
    // rather than suggested ones. The chart's own values are a judgement about
    // realism — a C shows less tooth than a B — and a bold cartoon wants them
    // read as white in every open shape, which at 0.6 alpha over black is grey.
    const fl = C.teethFloor || 0;
    ctx.globalAlpha = clamp(fl + (1 - fl) * p.teeth, 0, 1);
    toothBand(ctx, cx - hwL - 2, cx + hwR + 2, cy - up - 2, th + 2, C.teeth, C.scallop, true);
    if (dn > W * 0.10) {
      const bh = Math.min(dn * 0.42, W * 0.036) * mul;
      toothBand(ctx, cx - hwL - 2, cx + hwR + 2, cy + dn - bh, bh + 2, C.teeth, C.scallop, false);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** The two little curved marks a flat illustration uses in place of lips —
    the whole reason that style reads as a mouth rather than a hole. */
function creases(ctx, g, W, col) {
  const { cx, cy, up, dn } = g;
  const hwL = g.hwL == null ? g.hw : g.hwL, hwR = g.hwR == null ? g.hw : g.hwR;
  const o = W * 0.019;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, W * 0.0075);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - hwL * 0.66, cy - up - o);
  ctx.quadraticCurveTo(cx, cy - up - o * 1.9, cx + hwR * 0.66, cy - up - o);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - hwL * 0.72, cy + dn + o);
  ctx.quadraticCurveTo(cx, cy + dn + o * 1.9, cx + hwR * 0.72, cy + dn + o);
  ctx.stroke();
  ctx.restore();
}

/** F and V: upper teeth pressed onto a tucked lower lip. */
function biteOverlay(ctx, g, W, opt) {
  const { cx, cy } = g;
  // Unclipped — this IS the drawing for G — so unlike innards it cannot lean on
  // the aperture path to hide a front-on shape on a turned head.
  const hwL = g.hwL == null ? g.hw : g.hwL, hwR = g.hwR == null ? g.hw : g.hwR;
  const th = W * 0.055 * (g.view === 'profile' ? 0.82 : 1);
  ctx.save();
  ctx.fillStyle = opt.teeth;
  ctx.beginPath();
  const r = W * 0.012;
  ctx.moveTo(cx - hwL * 0.86, cy - th);
  ctx.lineTo(cx + hwR * 0.86, cy - th);
  ctx.quadraticCurveTo(cx + hwR * 0.86, cy + r, cx + hwR * 0.72, cy + r);
  ctx.lineTo(cx - hwL * 0.72, cy + r);
  ctx.quadraticCurveTo(cx - hwL * 0.86, cy + r, cx - hwL * 0.86, cy - th);
  ctx.closePath();
  ctx.fill();
  if (opt.stroke) { ctx.strokeStyle = opt.stroke; ctx.lineWidth = opt.lw * 0.7; ctx.stroke(); }
  ctx.fillStyle = opt.lip;
  ctx.beginPath();
  ctx.moveTo(cx - hwL, cy + r);
  ctx.quadraticCurveTo(cx, cy + W * 0.075, cx + hwR, cy + r);
  ctx.quadraticCurveTo(cx, cy + W * 0.030, cx - hwL, cy + r);
  ctx.closePath();
  ctx.fill();
  if (opt.stroke) ctx.stroke();
  ctx.restore();
}

/* Two parameterised renderers cover most of the chart: `inked` for drawn
   styles with an outline and a dark cavity, `lipped` for styles built from
   actual lip shapes. Line art and blocky stay bespoke. Every value that
   affects the picture lives in the preset, so a new style is a few lines. */

/* --- the side view is drawn, not derived -----------------------------------

   Three goes at deriving a profile from the front construction all failed the
   same way, and it is worth writing down why: front-on, the opening is a HOLE
   surrounded by lip. From the side it is not — the gap between the lips runs
   all the way out to the front of the face, so the silhouette is two separate
   lobes, an upper lip and a lower one, with the dark of the mouth between them.
   No amount of narrowing a ring gets you there; a ring is closed and this is
   not. So profile gets its own renderer, fed the same palette the front styles
   use, which is what keeps the fifteen recognisably themselves.
--------------------------------------------------------------------------- */
/** Everything the profile renderers need, worked out once from the geometry
    and the style's palette. Shared so that the line and blocky styles, which
    draw themselves, sit on exactly the same construction as the rest. */
function profileParts(W, g, C) {
  const { cx, cy, hwL: back, hwR: fwd, up: ou, dn: od, p } = g;
  const r = p.round;
  // An inked style carries no thickness — it is a line and a dark hole — so
  // its outline weight stands in for one.
  // With a floor: a style that carries neither a thickness nor an outline —
  // the flat one — drew its shut shapes as a hairline in profile, near enough
  // invisible against a puppet.
  const base = W * Math.max(C.thickness || 0, C.ow || 0, 0.030);
  // Lips thin as they stretch. A shut mouth keeps its full body — side on that
  // lump IS the drawing, and a hairline there is invisible against a puppet —
  // but an open one has the same flesh pulled around a much bigger hole, so it
  // has to get thinner. One constant could not serve both, and setting it for
  // the shut shapes is what left C, D and H as slabs of lip with a slot in
  // them. Measured off the opening rather than off the viseme, so a style that
  // scales its heights keeps the relationship.
  const stretch = 1 - 0.46 * clamp((ou + od) / (W * 0.26), 0, 1);
  // Thinner than they were. "These are the mass of the drawing now" was the
  // note that went with the old 1.26 / 1.48, and it was the wrong instinct —
  // the mass of a mouth seen from the side is teeth and dark, and the lips are
  // the band around them. Fat lips also hid the shapes: B, C and D differ by
  // how far the jaw has dropped, and that is invisible under a thick rim.
  const bodyU = base * (0.84 + 0.34 * r) * stretch;
  const bodyL = base * (1.00 + 0.40 * r) * stretch;   // the lower lip is fuller
  const bx = cx - back;
  const by = cy + (g.drop || 0);                // the corner, dropped with the jaw
  const uy = cy - ou, ly = cy + od;             // the two free edges, at the front
  const tipU = cx + fwd;
  // Set well back from the upper one, and further back again as the jaw drops.
  // This is the overbite, and it is the silhouette cue that separates a mouth
  // seen from the side from a symmetrical pair of lips: every drawn reference
  // has the upper lip out in front and the lower tucked behind it.
  const tipL = tipU - bodyU * (0.62 - 0.30 * r) - od * 0.20;
  return { cy, by, uy, ly, bx, tipU, tipL, ou, od, bodyU, bodyL, roll: r, base,
           shut: ou + od < base * 0.55,
           wedge: profileWedge(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, r),
           cav: profileCavity(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, r),
           rim: profileRim(bx, by, tipU, uy, tipL, ly, bodyU, bodyL, r),
           seam: profileSeam(bx, by, tipU, tipL, bodyU, r) };
}

/** Teeth and tongue behind a profile opening. Both sit near the FRONT: from
    the side you are looking in through the gap, and what is far enough back to
    be over the tongue's root is hidden by the cheek. */
function profileInnards(ctx, W, g, C, P) {
  const { by, uy, ly, bx, ou, od, cav, wedge } = P;
  const p = g.p;
  const gap = Math.max(1, ly - uy);
  ctx.save();
  // Built as a Path2D and passed to clip() explicitly. ctx.clip() with no
  // argument uses the CURRENT path, and after a fill() that is a trap: the
  // teeth escaped the mouth and drew a grey slab across the lip.
  ctx.clip(cav);

  /* The tongue, FIRST, and built off the floor of the mouth exactly as the
     lower tooth row is.

     It used to be a shape of its own: a curve from behind the corner, forward
     and up to a point, and back again. Two of its three anchors sat outside
     the cavity, so the clip threw most of it away and what survived was the
     tip — a pale spike rising out of the bottom lip on every shape with a
     tongue in it (B, C, D, E and H), crossing the lower teeth on its way. The
     lesson is the one the rest of this file already knew and this missed: in
     profile everything inside the mouth is a band along the roof or along the
     floor, deepening from nothing at the corner to its full depth at the
     front. Drawn that way the tongue is the floor of the mouth, which is what
     it is, and the teeth drawn over it afterwards sit in front of it, which is
     where they are. */
  if (p.tongue > 0.02 && od > W * 0.02 && gap > W * 0.02) {
    const tm = C.tongueMul || 1;
    // A low tongue is a shallow floor; a high one (the L shape) fills most of
    // the opening and reaches up behind the upper teeth.
    const th = Math.min(gap * (0.26 + 0.40 * clamp(p.tongue, 0, 1)), W * 0.085) * tm;
    ctx.fillStyle = C.tongue || '#DE6E7E';
    ctx.fill(profileTeeth(bx, by, ly, wedge, th, 1));
  }

  if (p.teeth > 0.02 && ou + od > W * 0.010) {
    // Most of the opening, not a stripe along the top of it. Each row takes
    // its share of the gap at the front — upper the larger, as it does on a
    // face — leaving a dark slot between them.
    const tm = C.teethMul || 1;
    // Between them they take most of the slot, leaving the dark as a line
    // through the middle that opens into a pocket at the back.
    const thU = Math.min(gap * 0.52, W * 0.105) * tm;
    // The lower row is much the smaller of the two, and smaller again than it
    // was: the floor of the mouth drops far further than the roof rises, so a
    // band of the same depth laid along it covers twice the area and the
    // drawing turns into a white bowl. It also has to leave room for the
    // tongue behind it, which is drawn first and only shows above it.
    const thL = Math.min(gap * 0.16, W * 0.040) * tm;
    // Nearly opaque, unlike the front view. Front-on the teeth are a band laid
    // over a dark aperture and a light touch reads as enamel; from the side
    // they are the mass of the drawing, and at the chart's own alpha they came
    // out as grey through black — the one thing the references never are.
    ctx.globalAlpha = clamp(0.56 + 0.44 * p.teeth, 0, 1);
    ctx.fillStyle = C.teeth || '#FFFAF0';
    // Both rows run from the corner to the front, deepening as they go — see
    // profileTeeth. Cutting them off at the FRONT half instead, which is where
    // the teeth really are, backfired badly enough to be worth recording: it
    // leaves the dark concentrated at the back of the mouth, and the eye reads
    // the darkest thing as the opening, so the whole mouth appeared to open
    // backwards. The dark has to be widest where the lips part. Anatomy loses
    // to legibility.
    ctx.fill(profileTeeth(bx, by, uy, wedge, thU, -1));
    if (gap > W * 0.05) ctx.fill(profileTeeth(bx, by, ly, wedge, thL, 1));
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** F and V in profile: the upper teeth come down onto the lower lip, which
    tucks back under them. From the side this is the clearest shape in the
    whole chart — front-on it has to be faked with an overlay — so it is worth
    drawing outright. */
function profileBite(ctx, W, g, C, P, kind) {
  const { bx, tipU, uy, ly, bodyU, rim, wedge } = P;
  const L = Math.max(1, tipU - bx);
  const lipCol = C.lip || C.lipDark || C.cavity || '#C4595F';
  const ink = C.ink || C.outline;
  const lw = Math.max(W * (C.ow || 0.006), W * 0.004);
  const solid = kind === 'inked' && !C.lip;
  // The lips as one shape, like every other profile viseme — the bite used to
  // build its own pair of lobes and they drifted apart into two floating slabs
  // that belonged to no face at all.
  ctx.fillStyle = solid ? (C.ink || '#16110F') : lipCol;
  ctx.fill(rim);
  if (ink && !solid) {
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke(rim);
  }
  // Then the upper teeth coming down out of it onto the lower lip. They start
  // well forward: a band run back to the corner reads as a slab laid across the
  // mouth rather than as the front teeth, which are the only ones in view from
  // the side. The bottom edge is the giveaway — it sits ON the lower lip rather
  // than floating over a gap, which is the whole shape of an F.
  const th = Math.max(W * 0.026, (ly - uy) * 0.60) * (C.teethMul || 1);
  const tx0 = bx + L * 0.56, tx1 = wedge.fu + bodyU * 0.10;
  ctx.save();
  ctx.clip(rim);
  ctx.fillStyle = C.teeth || '#FFFAF0';
  ctx.beginPath();
  ctx.moveTo(tx0, uy - th * 0.10);
  ctx.lineTo(tx1, uy - th * 0.06);
  ctx.quadraticCurveTo(tx1 + bodyU * 0.16, uy + th * 0.50, tx1 - bodyU * 0.20, uy + th);
  ctx.lineTo(tx0, uy + th * 0.86);
  ctx.closePath();
  ctx.fill();
  if (ink) { ctx.strokeStyle = ink; ctx.lineWidth = lw * 0.8; ctx.stroke(); }
  ctx.restore();
}

function profileMouth(ctx, W, g, C, kind) {
  const P = profileParts(W, g, C);
  const { cy, by, uy, ly, bx, tipU, tipL, ou, od, bodyU, bodyL, roll, base, cav, seam, shut } = P;
  const p = g.p;
  const lipped = kind === 'lipped';
  const ink = C.ink || C.outline;
  const lw = Math.max(W * (C.ow || 0), W * (lipped ? 0.005 : 0.020));

  // Centred on where the mouth actually sits, not on the nominal mouth line:
  // in profile the jaw carries the opening downward, so the two are not the
  // same place and a stipple pinned to the line drags the centring off.
  if (C.stubble) stubbleShadow(ctx, W, (cy + (od - ou) * 0.5) / 0.56, C.stubble);

  if (p.bite) return profileBite(ctx, W, g, C, P, kind);

  // Lips first for a lipped style — one ring, with the dark laid into it after.
  if (lipped) {
    let fill = C.lip;
    if (C.lipDark) {
      const grd = ctx.createLinearGradient(0, uy - bodyU * 1.5, 0, ly + bodyL * 1.5);
      grd.addColorStop(0, C.lipDark); grd.addColorStop(0.44, C.lip); grd.addColorStop(1, C.lipDark);
      fill = grd;
    }
    ctx.fillStyle = fill;
    ctx.fill(P.rim);
  }

  if (!shut) {
    ctx.fillStyle = C.cavity || '#25100F';
    ctx.fill(cav);
    profileInnards(ctx, W, g, C, P);
  }

  if (lipped) {
    if (C.gloss) {
      ctx.save(); ctx.clip(P.rim);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.44 * C.gloss).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(tipU - bodyU * 0.25, uy - bodyU * 1.35,
                  bodyU * 0.95, bodyU * 0.26, -0.22, 0, Math.PI * 2);
      ctx.fill(); ctx.restore();
      if (C.dot) {
        ctx.save(); ctx.clip(P.rim);
        ctx.fillStyle = 'rgba(255,239,212,.9)';
        ctx.beginPath();
        ctx.ellipse(tipL - bodyL * 0.2, ly + bodyL * 1.32,
                    bodyL * 0.30, bodyL * 0.18, -0.4, 0, Math.PI * 2);
        ctx.fill(); ctx.restore();
      }
    }
    // Shut, the ring closes into one lump; the seam is the only thing saying
    // there is a mouth in it at all.
    if (shut) {
      ctx.strokeStyle = C.cavity || ink || 'rgba(0,0,0,.5)';
      ctx.lineWidth = Math.max(base * 0.24, W * 0.006);
      ctx.lineCap = 'round';
      ctx.stroke(seam);
    }
    if (C.outline) {
      ctx.strokeStyle = C.outline; ctx.lineWidth = lw; ctx.lineJoin = 'round';
      ctx.stroke(P.rim);
    }
    return;
  }

  // An inked style has no lip body to draw: front-on it is a dark aperture with
  // a heavy line round it, and that is exactly what it should be here too.
  if (shut) {
    ctx.strokeStyle = ink || C.cavity || '#16110F';
    ctx.lineWidth = Math.max(lw, W * 0.017);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke(seam);
  } else if (ink) {
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    ctx.stroke(cav);
  }
  // Paper cut stands its lips in with two creases rather than drawing them.
  if (C.creases) {
    const o = W * 0.016, L = tipU - bx;
    ctx.strokeStyle = C.creases;
    ctx.lineWidth = Math.max(1, W * 0.0075);
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const edge = s < 0 ? uy : ly;
      ctx.beginPath();
      ctx.moveTo(bx + L * 0.30, by + (edge - by) * 0.55 + s * o);
      ctx.quadraticCurveTo(bx + L * 0.78, edge + s * o * 1.7,
                           tipU - bodyU * 0.3, edge + s * o * 0.6);
      ctx.stroke();
    }
  }
}

function inked(ctx, W, H, v, C) {
  const g = geom(v, W, H, C);
  if (g.view === 'profile') return profileMouth(ctx, W, g, C, 'inked');
  const lw = W * (C.ow || 0);
  if (VP[v].bite) {
    biteOverlay(ctx, g, W, { teeth: C.teeth, lip: C.lip || '#C4595F', stroke: C.ink, lw });
    return;
  }
  // With no outline there is no line width to hide a shut mouth inside, so a
  // closed shape has to be drawn as a deliberate stroke or it vanishes.
  const shutW = Math.max(lw, W * 0.017);
  if (g.up + g.dn < shutW * 0.9) {
    ctx.strokeStyle = C.ink || C.cavity;
    ctx.lineWidth = shutW; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(g.cx - g.hw, g.cy);
    ctx.quadraticCurveTo(g.cx, g.cy + W * 0.022, g.cx + g.hw, g.cy);
    ctx.stroke();
    if (C.creases) creases(ctx, g, W, C.creases);
    return;
  }
  fillCavity(ctx, g, C.cavity);
  innards(ctx, g, W, C);
  if (C.creases) creases(ctx, g, W, C.creases);
  if (!C.ink) return;
  ctx.strokeStyle = C.ink; ctx.lineWidth = lw; ctx.lineJoin = 'round';
  ctx.stroke(g.path);
}

/* --- a line that looks drawn by hand ----------------------------------------

   Three passes of the same path, each nudged and turned a hair, thin and part
   transparent. Where the passes agree the line is dark; where they disagree it
   frays. That is what a pen does on paper, and it is why this is three strokes
   rather than one wobbly one: a single jittered outline reads as a mistake,
   while three overlaid read as hand.

   The jitter has to be DETERMINISTIC. Random per frame and the mouth boils —
   every frame of the export is a differently wrong drawing and the result is
   unwatchable. So the seed is the viseme, and shape D is the same shape D
   every time it comes round.
--------------------------------------------------------------------------- */
function sketchStroke(ctx, path, W, C, seed, passes) {
  let st = (seed * 2654435761) >>> 0;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const j = W * (C.jitter == null ? 0.009 : C.jitter);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < (passes || 3); i++) {
    ctx.save();
    ctx.translate(W / 2, W * 0.56);
    ctx.rotate(rnd() * 0.022);
    ctx.scale(1 + rnd() * 0.018, 1 + rnd() * 0.022);
    ctx.translate(-W / 2 + rnd() * j, -W * 0.56 + rnd() * j);
    ctx.lineWidth = W * (C.ow || 0.009) * (0.86 + i * 0.16);
    ctx.globalAlpha = i === 0 ? 1 : 0.42;
    ctx.stroke(path);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function sketched(ctx, W, H, v, C) {
  const g = geom(v, W, H, C);
  const seed = VIS.indexOf(v) + 1;
  // The body is an ordinary lipped mouth with its outline suppressed; the pen
  // is drawn over it afterwards. Built this way rather than from scratch so
  // that the squiggle gets the three views, the bite shape and the innards for
  // nothing, and cannot drift away from the rest of the set.
  const body = Object.assign({}, C, { outline: null });
  lipped(ctx, W, H, v, body);
  ctx.strokeStyle = C.ink;
  if (g.view === 'profile') {
    sketchStroke(ctx, profileParts(W, g, C).rim, W, C, seed);
    return;
  }
  if (VP[v].bite) { sketchStroke(ctx, g.path, W, C, seed); return; }
  const t = W * C.thickness;
  // The outer lip edge gets the full three passes; the aperture gets two, so
  // the inside of the mouth stays readable instead of silting up with ink.
  sketchStroke(ctx, g.build(t * 0.5, t * 0.95, t * 1.15), W, C, seed);
  if (g.up + g.dn > W * 0.030) sketchStroke(ctx, g.path, W, C, seed + 17, 2);
}

/** A deterministic stipple — the same every frame, or it would shimmer. */
function stubbleShadow(ctx, W, H, strength) {
  const cx = W / 2, cy = H * 0.56;
  const rx = W * 0.36, ry = W * 0.29;
  ctx.save();
  const grd = ctx.createRadialGradient(cx, cy, W * 0.04, cx, cy, rx);
  grd.addColorStop(0, 'rgba(58,46,40,' + (0.20 * strength).toFixed(3) + ')');
  grd.addColorStop(1, 'rgba(58,46,40,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  let seed = 20240613;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  ctx.strokeStyle = 'rgba(42,34,30,1)';
  ctx.lineWidth = Math.max(1, W * 0.0032);
  ctx.lineCap = 'round';
  for (let i = 0; i < 300; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd());
    const x = cx + Math.cos(a) * rx * r, y = cy + Math.sin(a) * ry * r;
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    if (d > 1) continue;
    const len = W * 0.011 * (1 - d * 0.4);
    ctx.globalAlpha = (1 - d) * 0.55 * strength;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * 0.35, y + len);
    ctx.stroke();
  }
  ctx.restore();
}

function lipped(ctx, W, H, v, C) {
  const g = geom(v, W, H, C);
  if (g.view === 'profile') return profileMouth(ctx, W, g, C, 'lipped');
  const p = VP[v];
  const t = W * C.thickness;
  if (C.stubble) stubbleShadow(ctx, W, H, C.stubble);
  if (p.bite) {
    biteOverlay(ctx, g, W, { teeth: C.teeth, lip: C.lipDark || C.lip, stroke: C.outline, lw: W * (C.ow || 0.006) });
    return;
  }
  const inner = g.path;
  // The outer lip edge, built by the same view as the aperture — g.build is
  // what keeps a lipped style from drawing a front-on lip round a turned hole.
  const outer = g.build(t * 0.5, t * 0.95, t * 1.15);
  if (g.up + g.dn > W * 0.03) {
    fillCavity(ctx, g, C.cavity);
    innards(ctx, g, W, C);
  }
  const ring = new Path2D();
  ring.addPath(outer);
  ring.addPath(inner);

  let fill = C.lip;
  if (C.lipDark) {
    const grd = ctx.createLinearGradient(0, g.cy - g.up - t * 1.2, 0, g.cy + g.dn + t * 1.4);
    grd.addColorStop(0, C.lipDark);
    grd.addColorStop(0.42, C.lip);
    grd.addColorStop(1, C.lipDark);
    fill = grd;
  }
  ctx.fillStyle = fill;
  ctx.fill(ring, 'evenodd');

  if (C.gloss) {
    ctx.save();
    ctx.clip(ring, 'evenodd');
    ctx.fillStyle = 'rgba(255,255,255,' + (0.42 * C.gloss).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(g.cx + (g.hwR - g.hwL) * 0.3 - g.hw * 0.34, g.cy - g.up - t * 0.55,
                g.hw * 0.30, t * 0.24, -0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,' + (0.28 * C.gloss).toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy + g.dn + t * 0.6, g.hw * 0.42, t * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    if (C.dot) {
      ctx.fillStyle = 'rgba(255,239,212,.92)';
      ctx.beginPath();
      ctx.ellipse(g.cx + g.hw * 0.46, g.cy + g.dn + t * 0.58, t * 0.21, t * 0.14, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(g.cx - g.hw * 0.52, g.cy - g.up - t * 0.5, t * 0.15, t * 0.10, -0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if (C.outline) {
    ctx.strokeStyle = C.outline;
    ctx.lineWidth = W * (C.ow || 0.006);
    ctx.stroke(outer);
  }
}

/* The fifteen styles are defined ONCE. The three views are derived from them
   below, so a change to a style reaches its front, three-quarter and profile
   together and they cannot drift into being three different mouths. */
const STYLE_DEFS = {
  cartoon: {
    label: 'Cartoon',
    draw: (c, W, H, v, V) => inked(c, W, H, v, { view: V,
      ink: '#16110F', ow: 0.030, cavity: '#25100F', teeth: '#FFFAF0', tongue: '#DE6E7E'
    })
  },
  hose: {
    label: 'Rubber hose',
    draw: (c, W, H, v, V) => inked(c, W, H, v, { view: V,
      ink: '#191614', ow: 0.044, cavity: '#241214', teeth: '#FFFFFF', tongue: '#E8848F',
      widthMul: 0.94, heightMul: 1.18
    })
  },
  line: {
    label: 'Line art',
    draw(ctx, W, H, v, V) {
      const g = geom(v, W, H, { view: V });
      const lw = W * 0.017;
      const ink = '#1A1D24';
      ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (g.view === 'profile') {
        // Line art is the one style with nothing to fill, so it gets the
        // profile construction as pure contour: the two lip edges and, when
        // they are apart, whatever shows between them.
        const C = { ow: 0.017, teeth: ink, tongue: ink };
        const P = profileParts(W, g, C);
        if (VP[v].bite) {
          const L = P.tipU - P.bx;
          const th = Math.max(W * 0.026, (P.ly - P.uy) * 0.60);
          const tx0 = P.bx + L * 0.56, tx1 = P.wedge.fu + P.bodyU * 0.10;
          ctx.stroke(P.rim);
          ctx.save(); ctx.clip(P.rim); ctx.lineWidth = lw * 0.75;
          ctx.beginPath();
          ctx.moveTo(tx0, P.uy + th * 0.86);
          ctx.lineTo(tx1 - P.bodyU * 0.20, P.uy + th);
          ctx.quadraticCurveTo(tx1 + P.bodyU * 0.16, P.uy + th * 0.50, tx1, P.uy - th * 0.06);
          ctx.stroke();
          ctx.restore();
          return;
        }
        if (P.shut) { ctx.stroke(P.seam); return; }
        ctx.stroke(P.cav);
        const p = VP[v], L = P.tipU - P.bx, span = P.ly - P.by;
        ctx.save(); ctx.clip(P.cav); ctx.lineWidth = lw * 0.75;
        if (p.teeth > 0.3 && P.ly - P.uy > W * 0.022) {
          const y = P.uy + Math.min((P.ly - P.uy) * 0.34, W * 0.030);
          ctx.beginPath();
          ctx.moveTo(P.bx + L * 0.34, P.uy + (P.by - P.uy) * 0.30);
          ctx.quadraticCurveTo(P.bx + L * 0.66, y, P.tipU, y);
          ctx.stroke();
        }
        if (p.tongue > 0.4 && P.ly - P.uy > W * 0.05) {
          const lift = clamp(p.tongue, 0, 1);
          ctx.beginPath();
          ctx.moveTo(P.bx, P.by + span * 0.55);
          ctx.quadraticCurveTo(P.bx + L * 0.52, P.ly + span * 0.04,
                               P.bx + L * 0.94, P.ly - span * (0.28 + lift * 0.60));
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
      if (VP[v].bite) {
        biteOverlay(ctx, g, W, { teeth: 'rgba(0,0,0,0)', lip: 'rgba(0,0,0,0)', stroke: ink, lw: lw * 1.6 });
        return;
      }
      if (g.up + g.dn < lw * 1.4) {
        ctx.beginPath();
        ctx.moveTo(g.cx - g.hw, g.cy);
        ctx.quadraticCurveTo(g.cx, g.cy + W * 0.020, g.cx + g.hw, g.cy);
        ctx.stroke();
        return;
      }
      ctx.stroke(g.path);
      const p = VP[v];
      ctx.save(); ctx.clip(g.path);
      ctx.lineWidth = lw * 0.75;
      if (p.teeth > 0.3 && g.up > W * 0.012) {
        const y = g.cy - g.up + Math.min(g.up * 1.0, W * 0.055);
        ctx.beginPath(); ctx.moveTo(g.cx - g.hw, y); ctx.lineTo(g.cx + g.hw, y); ctx.stroke();
      }
      if (p.tongue > 0.4 && g.dn > W * 0.05) {
        ctx.beginPath();
        ctx.ellipse(g.cx, g.cy + g.dn * 0.72, g.hw * 0.6, g.dn * 0.5 * p.tongue, 0, Math.PI, 0, true);
        ctx.stroke();
      }
      ctx.restore();
    }
  },
  block: {
    label: 'Blocky',
    draw(ctx, W, H, v, V) {
      const g = geom(v, W, H, { view: V });
      const p = VP[v];
      if (g.view === 'profile') {
        // Same ring construction, drawn with the blocky palette: one slab of
        // coral with the dark cut out of it.
        const C = { thickness: 0.052, cavity: '#2E2530', teeth: '#F4EFE4',
                    tongue: '#E08B93', lip: '#D2705C' };
        const P = profileParts(W, g, C);
        if (p.bite) { profileBite(ctx, W, g, C, P, 'lipped'); return; }
        ctx.fillStyle = C.lip;
        ctx.fill(P.rim);
        if (!P.shut) {
          ctx.fillStyle = C.cavity; ctx.fill(P.cav);
          profileInnards(ctx, W, g, C, P);
        } else {
          ctx.strokeStyle = C.cavity;
          ctx.lineWidth = Math.max(P.base * 0.26, W * 0.007);
          ctx.lineCap = 'round';
          ctx.stroke(P.seam);
        }
        return;
      }
      if (p.bite) {
        biteOverlay(ctx, g, W, { teeth: '#F4EFE4', lip: '#D2705C', stroke: null, lw: 0 });
        return;
      }
      const minH = W * 0.026;
      const hh = Math.max(minH, (g.up + g.dn) / 2);
      const rx = Math.min(g.hw, hh) * (0.35 + 0.65 * p.round);
      ctx.fillStyle = '#D2705C';
      roundRect(ctx, g.cx - g.hw, g.cy - hh, g.hw * 2, hh * 2, rx + W * 0.018);
      ctx.fill();
      if (g.up + g.dn > W * 0.05) {
        ctx.fillStyle = '#2E2530';
        const ih = hh - W * 0.020, iw = g.hw - W * 0.018;
        roundRect(ctx, g.cx - iw, g.cy - ih, iw * 2, ih * 2, Math.max(2, rx));
        ctx.fill();
        ctx.save();
        roundRect(ctx, g.cx - iw, g.cy - ih, iw * 2, ih * 2, Math.max(2, rx));
        ctx.clip();
        if (p.teeth > 0.2) {
          ctx.fillStyle = '#F4EFE4';
          ctx.fillRect(g.cx - iw, g.cy - ih, iw * 2, Math.min(ih * 0.9, W * 0.05));
        }
        if (p.tongue > 0.4) {
          ctx.fillStyle = '#E08B93';
          ctx.fillRect(g.cx - iw * 0.7, g.cy + ih - Math.min(ih, W * 0.055), iw * 1.4, W * 0.055);
        }
        ctx.restore();
      }
    }
  },
  minimal: {
    label: 'Minimal',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#E6D2CA', gloss: 0, thickness: 0.030, outline: '#8A6E66', ow: 0.008,
      cavity: '#4A3A38', teeth: '#FFFFFF', tongue: '#C98E92'
    })
  },
  natural: {
    label: 'Natural',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#BE7A73', lipDark: '#96574F', gloss: 0.12, thickness: 0.046,
      cavity: '#3A1F22', teeth: '#F7F1E6', tongue: '#CE7F84', outline: 'rgba(60,32,28,.35)'
    })
  },
  full: {
    label: 'Full lips',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#C0454F', lipDark: '#8E2C38', gloss: 0.9, thickness: 0.056,
      cavity: '#2A1218', teeth: '#FBF6EC', tongue: '#D9707F', outline: 'rgba(50,16,22,.42)'
    })
  },
  masc: {
    label: 'Masculine',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      // wider, flatter, matte, and set closer to skin than the feminine styles
      lip: '#A9736A', lipDark: '#7E4F48', gloss: 0, thickness: 0.034,
      widthMul: 1.14, heightMul: 0.96,
      cavity: '#2E1A18', teeth: '#F4EEE2', tongue: '#C0757A',
      outline: 'rgba(48,28,24,.45)', ow: 0.0055
    })
  },
  stubble: {
    label: 'Stubble',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#A06C63', lipDark: '#77463F', gloss: 0, thickness: 0.032,
      widthMul: 1.14, heightMul: 0.96, stubble: 0.95,
      cavity: '#2B1715', teeth: '#F2EBDE', tongue: '#BC7076',
      outline: 'rgba(44,26,22,.5)', ow: 0.0055
    })
  },
  realistic: {
    label: 'Realistic',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#B26A67', lipDark: '#8A4744', gloss: 0.35, thickness: 0.050,
      cavity: '#2B1517', teeth: '#FAF4E8', tongue: '#D07E82',
      outline: 'rgba(40,20,20,.30)', ow: 0.005
    })
  },

  /* The sticker look: one flat coral, a heavy black keyline, nothing else.
     It holds up when the mouth is small on screen, which the softer styles
     do not. */
  sticker: {
    label: 'Sticker',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#F2896B', gloss: 0, thickness: 0.070, widthMul: 0.97,
      outline: '#15120F', ow: 0.026,
      cavity: '#171214', teeth: '#FFFFFF', tongue: '#E8503F'
    })
  },

  /* Big scalloped teeth — the broad toon smile, where you can count them. */
  toon: {
    label: 'Toon teeth',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#EE7059', lipDark: '#D2523E', gloss: 0.25, thickness: 0.054,
      cavity: '#7E1A22', teeth: '#FFF8EC', tongue: '#E23B3B',
      scallop: true, teethMul: 1.9,
      outline: 'rgba(122,42,32,.38)', ow: 0.006
    })
  },

  glossy: {
    label: 'Glossy',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#F03A63', lipDark: '#BF1B47', gloss: 1, dot: true, thickness: 0.060,
      cavity: '#3A0E1E', teeth: '#FFFFFF', tongue: '#F0616E',
      outline: 'rgba(70,10,30,.30)', ow: 0.005
    })
  },

  /* Flat vector with no lips at all: the mouth is the dark shape, and two
     small creases stand in for the lips that were never drawn. */
  smiley: {
    label: 'Smiley',
    // The big friendly cartoon mouth: a heavy black line, a solid black inside,
    // a broad band of white across the top and a red tongue filling the floor.
    // Not a variation on Cartoon — the difference is where the mass goes. In
    // Cartoon the dark is the mouth and the teeth are a detail; here the teeth
    // and the tongue take most of the opening and the dark is the gap between
    // them, which is what makes it read as a grin rather than as a hole.
    draw: (c, W, H, v, V) => inked(c, W, H, v, { view: V,
      ink: '#000000', ow: 0.040, cavity: '#000000',
      teeth: '#FFFFFF', teethFloor: 0.88, tongue: '#E8252A',
      widthMul: 1.08, teethMul: 1.95, tongueMul: 1.55, scallop: false
    })
  },
  squiggle: {
    label: 'Squiggly',
    // Pen on paper: thin, a little off-register, the ink never quite closing on
    // itself. For drawings that are themselves wobbly, where a clean vector
    // mouth sits on the face like a sticker.
    draw: (c, W, H, v, V) => sketched(c, W, H, v, { view: V,
      ink: '#2E2A26', ow: 0.0095, jitter: 0.017, thickness: 0.046,
      lip: '#E59488', lipDark: '#C9736B', cavity: '#3B2628',
      teeth: '#FFFDF6', teethFloor: 0.74, tongue: '#D4848A',
      teethMul: 1.05, tongueMul: 0.9
    })
  },
  /* --- the four that go with the drawn faces -------------------------------

     Not four more looks for the shelf so much as four answers to "what should
     this face's mouth be": the line weight matches the faces' own, the colour
     is picked against each one's skin, and the proportions follow the head —
     the child's narrower and rounder, the older one's thinner and flatter. A
     drawn face comes with its own one already chosen, and they are in the
     shelf as well because a puppet of your own may want the same treatment. */
  faceman: {
    label: 'Man',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#CE8A7C', lipDark: '#AF6B5B', gloss: 0.10, thickness: 0.040,
      widthMul: 1.08, heightMul: 0.96,
      cavity: '#3A2220', teeth: '#FFFBF2', teethFloor: 0.5, tongue: '#CF7A80',
      outline: '#2B2724', ow: 0.0095
    })
  },
  facewoman: {
    label: 'Woman',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#D25B6B', lipDark: '#A73C50', gloss: 0.45, thickness: 0.050,
      widthMul: 0.98,
      cavity: '#331A1E', teeth: '#FFFCF4', teethFloor: 0.5, tongue: '#D9757F',
      outline: '#2B2724', ow: 0.0095
    })
  },
  facechild: {
    label: 'Child',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#E08980', lipDark: '#C46660', gloss: 0.22, thickness: 0.044,
      widthMul: 0.90, heightMul: 0.95, teethMul: 1.2,
      cavity: '#3B2322', teeth: '#FFFFFF', teethFloor: 0.6, tongue: '#DF8A90',
      outline: '#2B2724', ow: 0.0105
    })
  },
  faceolder: {
    label: 'Older',
    draw: (c, W, H, v, V) => lipped(c, W, H, v, { view: V,
      lip: '#C59A90', lipDark: '#A67B72', gloss: 0.05, thickness: 0.034,
      widthMul: 1.02, heightMul: 0.90,
      cavity: '#352422', teeth: '#EFE6D4', teethFloor: 0.45, tongue: '#C58288',
      outline: '#2B2724', ow: 0.0095
    })
  },
  paper: {
    label: 'Paper cut',
    draw: (c, W, H, v, V) => inked(c, W, H, v, { view: V,
      ink: null, ow: 0, widthMul: 1.04,
      cavity: '#7A1626', teeth: '#FFFFFF', tongue: '#E8437A',
      teethMul: 1.15, tongueMul: 1.1, creases: '#D9A183', lip: '#D9A183'
    })
  },

  flat: {
    label: 'Flat',
    draw: (c, W, H, v, V) => inked(c, W, H, v, { view: V,
      ink: null, ow: 0, widthMul: 1.10, heightMul: 0.94,
      cavity: '#5E1220', teeth: '#EDF0F1', tongue: '#EE3D6E',
      teethMul: 0.65, tongueMul: 1.35, lip: '#5E1220'
    })
  }
};

/* --- fifteen styles x three views = the forty-five on offer ----------------

   Ids are `<style>` for front and `<style>-three` / `<style>-profile` for the
   turned ones. The front id is left alone on purpose: a clip saved before the
   views existed still names `cartoon`, and it must keep meaning what it meant.
--------------------------------------------------------------------------- */
const STYLE_VIEWS = ['front', 'three', 'profile'];
const styleViewId = (base, view) => view === 'front' ? base : base + '-' + view;

const STYLES = {};
Object.keys(STYLE_DEFS).forEach(base => {
  const def = STYLE_DEFS[base];
  STYLE_VIEWS.forEach(view => {
    STYLES[styleViewId(base, view)] = {
      label: def.label,
      base, view,
      draw(ctx, W, H, v) {
        // A turned mouth does not sit square on the face: it follows the curve
        // of it. The tilt is part of the drawing rather than something applied
        // afterwards, so the centring pass measures the shape that is really
        // drawn.
        const tilt = view === 'three' ? -0.055 : 0;
        if (!tilt) return def.draw(ctx, W, H, v, view);
        ctx.save();
        ctx.translate(W / 2, H * 0.56);
        ctx.rotate(tilt);
        ctx.translate(-W / 2, -H * 0.56);
        def.draw(ctx, W, H, v, view);
        ctx.restore();
      }
    };
  });
});

/** The styles belonging to one view, in the order they were defined. */
const stylesInView = view =>
  Object.keys(STYLE_DEFS).map(base => styleViewId(base, view));

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Custom art overrides the procedural styles when loaded. */
const custom = { on: false, map: {}, sources: [] };

function paintMouth(ctx, W, H, v, styleId, bg) {
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); } else ctx.clearRect(0, 0, W, H);
  if (mirror.lips) {
    // Around the middle of the tile, so a mirrored mouth stays where it was put
    // rather than jumping across the frame. Restored at every return below,
    // which is why the whole body is wrapped rather than each branch.
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    try { paintMouthArt(ctx, W, H, v, styleId); } finally { ctx.restore(); }
    return;
  }
  paintMouthArt(ctx, W, H, v, styleId);
}

function paintMouthArt(ctx, W, H, v, styleId) {
  if (custom.on) {
    const src = custom.map[v];
    if (src && src.img) {
      const { img, sx, sy, sw, sh } = src;
      const s = Math.min(W / sw, H / sh);
      const dw = sw * s, dh = sh * s;
      ctx.drawImage(img, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
      return;
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(140,150,165,.75)';
    ctx.setLineDash([W * 0.03, W * 0.03]);
    ctx.lineWidth = W * 0.012;
    roundRect(ctx, W * 0.14, H * 0.14, W * 0.72, H * 0.72, W * 0.05);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const st = STYLES[styleId] || STYLES.cartoon;
  // Centred on its own artwork. The shapes are drawn around H * 0.56 — a mouth
  // sits below the middle of a FACE — but this canvas is the mouth tile, not a
  // face, and everything downstream treats the tile as centred: the placement
  // overlay, the chart, the sprite sheet, the GIF and the Final Cut stills. So
  // the whole drawing is nudged until the nine shapes together sit in the
  // middle of the frame. Measured per style rather than by one constant,
  // because the styles do not all cover the same ground.
  const o = styleCentreOffset(st, styleId);
  if (o.dx || o.dy) {
    ctx.save();
    // Whole pixels. A half-pixel shift re-rasterises everything soft — the
    // stipple on the masculine styles especially — and hairs that were just
    // over the alpha threshold fall under it or the reverse, which moves the
    // measured centre by several pixels and makes the correction wrong by
    // about as much as it was correcting.
    //
    // Not negated under the mirror, which is worth stating because it looks
    // wrong. The flip is applied to the finished tile, so the offset happens in
    // art space first and is carried across by the mirror along with everything
    // else: nudging right and then mirroring puts the drawing left, which is
    // what a mirror of a drawing nudged right looks like. Negating it here —
    // the first guess — put the three-quarter styles off by twice their offset.
    ctx.translate(Math.round(o.dx * W), Math.round(o.dy * H));
    st.draw(ctx, W, H, v);
    ctx.restore();
  } else {
    st.draw(ctx, W, H, v);
  }
}

/** How far to shift a style so its nine shapes are centred, as a fraction of
    the frame height. Worked out once per style by drawing them and looking,
    so it stays right if the artwork is ever changed. */
const styleOffsets = new Map();
function styleCentreOffset(st, id) {
  const key = id || 'cartoon';
  if (styleOffsets.has(key)) return styleOffsets.get(key);
  // BOTH axes. Vertical alone was enough while every style was symmetrical
  // about the middle of the tile; a turned mouth is not, and the front-on
  // assumption put the three-quarter styles up to 18px off-centre — which would
  // have shifted the mouth in every export, silently.
  let off = { dx: 0, dy: 0 };
  try {
    // Measured at the size the rest of the app cares about. At 160 the soft
    // edge of a stipple or a shadow crosses the alpha threshold on a different
    // pixel than it does at 200, and the correction came out a few pixels wrong
    // on exactly the styles that have one.
    const S = 200;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    let top = S, bot = -1, left = S, right = -1;
    for (const v of VIS) {
      x.clearRect(0, 0, S, S);
      st.draw(x, S, S, v);
      const d = x.getImageData(0, 0, S, S).data;
      for (let row = 0; row < S; row++) {
        for (let col = 0; col < S; col++) {
          // A firm threshold: soft shadows and stipple must not decide where
          // the mouth is.
          if (d[(row * S + col) * 4 + 3] < 96) continue;
          if (row < top) top = row;
          if (row > bot) bot = row;
          if (col < left) left = col;
          if (col > right) right = col;
        }
      }
    }
    if (bot >= top) off.dy = clamp(0.5 - (top + bot) / 2 / S, -0.25, 0.25);
    if (right >= left) off.dx = clamp(0.5 - (left + right) / 2 / S, -0.25, 0.25);
  } catch (e) { /* a style that will not render is not worth a crash */ }
  styleOffsets.set(key, off);
  return off;
}

/* -------------------------------------------------------------- app state */

const $ = id => document.getElementById(id);
const state = {
  buffer: null, srcBuffer: null, mono: null, name: '', file: null, frames: [], fps: 12,
  style: 'cartoon', sel: 0, selEnd: 0, dirty: false, video: null, script: [], needsAudio: false,
  srcAudio: null, videoDecodable: true, videoCodec: null
};
const cfg = { gate: 12, vs: 1, hold: 2, closures: true, detectL: false };
const download = { mode: 'file', api: null };

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), ms);
}

const fmtTime = s => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0') + '.' +
    String(Math.floor((s % 1) * 100)).padStart(2, '0');
};
const fmtBytes = b =>
  b < 1024 ? b + ' B' :
  b < 1048576 ? (b / 1024).toFixed(0) + ' KB' :
  (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';

/* ------------------------------------------------------------ audio loading */

/* An AudioContext is a scarce per-tab hardware resource: open several copies of
   this page and the browser refuses to hand out more, which silently kills
   playback until every tab is closed. So the context is used only to decode,
   and closed the moment it has. Playback runs through a plain <audio> element,
   which has no such limit, needs no resuming, and survives a backgrounded tab. */
async function decodeAudio(arrayBuffer) {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (Ctor) {
    let ctx = null;
    try {
      ctx = new Ctor();
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      console.warn('AudioContext decode failed, falling back to offline', e);
    } finally {
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    }
  }
  // OfflineAudioContext is not a hardware context, so it always exists
  const OCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OCtor) throw new Error('this browser cannot decode audio');
  const off = new OCtor(1, 1, 44100);
  return await off.decodeAudioData(arrayBuffer.slice(0));
}

/* The player lives in the page, inside the preview, rather than being a hidden
   element we screenshot. A <video> plays a bare audio file perfectly well, and
   when the source really is video it is shown directly with the mouth drawn on
   a transparent canvas above it. That matters beyond tidiness: WebKit does not
   decode frames for a display:none video, so anything built on drawImage from
   one renders black in Safari while working fine in Chromium. */
const player = document.getElementById('stageVideo');
player.preload = 'auto';
player.playsInline = true;
let playerURL = null;

/* Where the mouth sits on the video, in fractions of the frame. */
const overlay = { x: 0.5, y: 0.66, size: 0.30, rot: 0, keyed: false, keys: [] };
/* --- two mirrors, kept apart -------------------------------------------------

   A puppet photographed facing left needs lips facing left, and a lip set drawn
   facing right has to be turned round to meet it. But the reverse happens just
   as often: the puppet is the thing facing the wrong way and the lips are fine.
   So they are two switches rather than one, and neither moves the other.

   Only horizontal. A mouth upside down is not a mouth, and a puppet upside down
   is a different problem.

   `lips` is applied inside `paintMouth`, which is the one door every drawing of
   a mouth goes through — stage, chart, sprite sheet, GIF, animated PNG, video,
   Final Cut stills. The style CHIPS draw through `STYLES[id].draw` instead and
   so stay unmirrored, which is right: they are a picker, not a preview of the
   output.

   `plate` is applied in three places because the puppet is shown three ways: as
   a DOM element on the stage (a CSS transform), as pixels in an export
   (`drawPlateFrame`), and as a file handed to Final Cut, which gets a transform
   in the project instead so the file itself is untouched. */
const mirror = { lips: false, plate: false };

/* ---- the puppet's own placement ----------------------------------------------

   The frame stays the puppet's own shape and size; what moves is the puppet
   inside it. `size` 1 means "fills the frame", which is what it always did, so
   a clip made before any of this existed draws identically.

   Scaled down, the margin left behind is transparent — which is the point as
   often as not: a drawing cropped tight to the figure has no air round it, and
   a mouth placed near the chin ends up against the edge of every export.

   One transform, written once and applied in three places that must agree: the
   stage (as a CSS transform on the picture element under the canvas), every
   export that composites the puppet, and the blur patch when it lifts a piece
   of the picture to smear. Three implementations of the same arithmetic is how
   the patch ends up sampling the wrong part of a mirrored puppet, which has
   happened here before. */
const PUPPET_POSE = { x: 0.5, y: 0.5, size: 1, rot: 0 };
const puppetPose = { ...PUPPET_POSE };


function puppetMoved() {
  return Math.abs(puppetPose.size - 1) > 1e-6 || Math.abs(puppetPose.rot) > 1e-6 ||
         Math.abs(puppetPose.x - 0.5) > 1e-6 || Math.abs(puppetPose.y - 0.5) > 1e-6;
}

function applyPuppetTransform(ctx, W, H) {
  ctx.translate(puppetPose.x * W, puppetPose.y * H);
  ctx.rotate(puppetPose.rot * Math.PI / 180);
  ctx.scale((mirror.plate ? -1 : 1) * puppetPose.size, puppetPose.size);
  ctx.translate(-W / 2, -H / 2);
}

/** The same transform for the <img>/<video> sitting under the stage canvas.
    Percentages in a CSS translate are of the element's own box, which is the
    stage, so the two agree by construction. */
function syncPlateTransform() {
  // Only the moving pictures are elements now: a still is drawn into the stage
  // canvas like every other layer, which is what lets it be reordered. These
  // two are laid out by hand rather than by CSS percentages, because the frame
  // is no longer always the same shape as the picture and `left: 10%` of a
  // letterboxed box is not where the canvas would have drawn it.
  const stage = document.getElementById('stage');
  if (!stage) return;
  const W = stage.width, H = stage.height;
  const pz = plateSize() || { w: W, h: H };
  const w = puppetPose.size * W;
  const h = w * (pz.h / Math.max(1, pz.w));
  const css = {
    position: 'absolute',
    left: ((puppetPose.x * W - w / 2) / W * 100).toFixed(4) + '%',
    top: ((puppetPose.y * H - h / 2) / H * 100).toFixed(4) + '%',
    width: (w / W * 100).toFixed(4) + '%',
    height: (h / H * 100).toFixed(4) + '%',
    transform: 'rotate(' + puppetPose.rot.toFixed(3) + 'deg)' +
               (mirror.plate ? ' scaleX(-1)' : ''),
    transformOrigin: 'center'
  };
  ['platePlayer', 'stageVideo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) Object.assign(el.style, css);
  });
}
const patch = { on: false, blur: 0.35, cover: 1.25 };   // the blur that hides a printed mouth
const mouthCanvas = document.createElement('canvas');
function mouthImage(size, v, style) {
  // Math.max(8, NaN) is NaN, so an unguarded Math.max is no guard at all: a
  // non-finite size walks all the way down into createLinearGradient, throws
  // there, and takes the whole draw with it. That matters more than a bad
  // frame — drawStage is called from inside sizeStage, which is called from
  // inside the async head-switch, so one NaN pose abandons the switch halfway
  // and leaves a head on the stage that nothing has recorded. A pose can go
  // non-finite from a keyframe list that is missing a frame number, which is
  // exactly what a hand-built key or an older saved clip can be.
  size = Number.isFinite(size) ? Math.max(8, Math.round(size)) : 8;
  if (mouthCanvas.width !== size) { mouthCanvas.width = mouthCanvas.height = size; }
  paintMouth(mouthCanvas.getContext('2d'), size, size, v, style);
  return mouthCanvas;
}

/* iOS ignores preload and fetches nothing until playback is requested, so a
   video there sits at readyState 0 forever and renders black. Choosing the file
   is a user gesture, which is exactly when a muted play is permitted — start it,
   let a frame arrive, then stop and restore the sound. */
async function primeVideo() {
  const wasMuted = player.muted;
  try {
    player.muted = true;
    const p = player.play();
    if (p && p.then) await p;
    await new Promise(r => setTimeout(r, 220));
  } catch (e) {
    console.warn('could not prime the video decoder:', e);
  } finally {
    try { player.pause(); } catch (e) {}
    try { player.currentTime = 0; } catch (e) {}
    player.muted = wasMuted;
  }
}

/** Does the picture actually decode?

    Drawn pixels are opaque, so nothing drawn leaves the canvas transparent.
    This only gates the overlay export — the preview shows the video element
    directly — so it errs towards yes: a false no would withhold a feature that
    works, while a false yes shows up plainly as black frames in the export. */
async function videoYieldsFrame() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');

  await new Promise(res => {
    const done = () => { player.removeEventListener('seeked', done); res(); };
    player.addEventListener('seeked', done);
    try { player.currentTime = 0.04; } catch (e) { done(); return; }
    setTimeout(done, 2000);
  });

  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    ctx.clearRect(0, 0, 32, 32);
    try { ctx.drawImage(player, 0, 0, 32, 32); } catch (e) { /* no frame yet */ }
    try {
      const d = ctx.getImageData(0, 0, 32, 32).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    } catch (e) {
      return true;              // reading was refused, not the picture
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // Frames never reached the canvas, but the element says it has data to play.
  // Believe the element: the export is the only thing riding on this.
  return player.readyState >= 2;
}

/** Naming the codec turns a black rectangle into something you can act on. */
function updateCodecNote() {
  const el = $('codecNote');
  if (!el) return;
  const vc = state.videoCodec;
  if (!state.video || !vc || vc.universal) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('warn', !state.videoDecodable);
  el.innerHTML = state.videoDecodable
    ? 'This clip is <b>' + vc.name + '</b>. It plays here, but other browsers may not take it — ' +
      'convert to H.264 if you need it to travel.'
    : 'This clip is <b>' + vc.name + '</b> and no frames are reaching the page. ' +
      (vc.note ? vc.note + '. ' : '') + 'Convert it to H.264 and it will play.';
}

/* ---- the queue -------------------------------------------------------------

   Batch mode is a queue of short clips, one of which is open. Only the open
   clip is decoded: a minute of audio costs about 35 MB once it is a Float32
   AudioBuffer, so twenty of them held at once would take the tab down. A clip
   that is not open keeps its File — which the browser has on disk anyway —
   plus its frames, its edits and its settings, which together are kilobytes.
   Opening one decodes it again and hands back the saved frames rather than
   re-analysing, so an edit made an hour ago is still there.

   The limits are deliberate and stated up front rather than discovered on the
   twenty-first file. Longer than this is not refused work — it is work for one
   clip at a time, which is what the app already does well.
--------------------------------------------------------------------------- */

const BATCH_MAX_CLIPS = 24;
const BATCH_MAX_SECONDS = 60;
// A whole run now comes down as one file, so there is a ceiling on what one
// download can reasonably carry. Frame sequences are the only export that gets
// anywhere near it; everything else is orders of magnitude under.
const BATCH_MAX_BYTES = 600 * 1024 * 1024;
const queue = { clips: [], activeId: null };

const activeClip = () => queue.clips.find(c => c.id === queue.activeId) || null;

/* --- trimming -------------------------------------------------------------

   A trim is a window over the source file. The clip that comes out of it is
   treated as a thing that starts at zero: the exposure sheet, the timing, the
   keys and every export count from the first trimmed frame. Keeping a second
   "absolute" time base alongside the relative one is how sync bugs breed.

   The media element still holds the whole file, so playback is windowed —
   `trimIn` is added on the way in and taken off on the way out. */
const trimIn = () => { const c = activeClip(); return c ? (c.in || 0) : 0; };
const isTrimmed = () => {
  const c = activeClip();
  return !!c && ((c.in || 0) > 0.001 || (c.drops || []).length > 0 ||
                 (c.out != null && c.srcDuration && c.out < c.srcDuration - 0.001));
};

/* --- dropped bits ---------------------------------------------------------

   `in`/`out` say where the clip starts and stops. `drops` says which bits in
   between were thrown away — split points divide the clip into segments, and a
   segment can be dropped. So the clip's material is no longer one window over
   the source but a LIST of them, and the source->clip mapping stops being an
   addition and becomes piecewise.

   That is the whole cost of the feature, and it is paid in exactly three
   places: these maps, the buffer rebuild, and the playback skip. Everything
   downstream — the exposure sheet, the analysis, the keys, every export —
   works off `state.buffer`, which is already the concatenated result, and so
   never learns that any of this happened.

   With no drops these functions are the old arithmetic to the letter, and they
   say so by short-circuiting: the untrimmed path cannot regress because it does
   not run any new code. */

/** The clip's material as a list of [a, b] over the source, in order. */
function keptRanges(clip) {
  if (!clip) return [];
  const a = clip.in || 0;
  const b = clip.out == null ? (clip.srcDuration || 0) : clip.out;
  const drops = (clip.drops || []).filter(d => d[1] > a && d[0] < b)
                                  .sort((x, y) => x[0] - y[0]);
  if (!drops.length) return [[a, b]];
  const out = [];
  let at = a;
  drops.forEach(d => {
    const s = Math.max(a, d[0]), e = Math.min(b, d[1]);
    if (s > at + 1e-6) out.push([at, s]);
    at = Math.max(at, e);
  });
  if (b > at + 1e-6) out.push([at, b]);
  return out;
}

/** How much of the source the clip actually keeps. */
function keptDuration(clip) {
  return keptRanges(clip).reduce((n, r) => n + (r[1] - r[0]), 0);
}

/** Seconds into the clip -> seconds into the source. */
function clipToSrc(clip, tc) {
  const rs = keptRanges(clip);
  if (!rs.length) return 0;
  let left = Math.max(0, tc);
  for (let i = 0; i < rs.length; i++) {
    const len = rs[i][1] - rs[i][0];
    if (left < len || i === rs.length - 1) return rs[i][0] + Math.min(left, len);
    left -= len;
  }
  return rs[rs.length - 1][1];
}

/** Seconds into the source -> seconds into the clip. A time inside a dropped
    bit has no clip time at all; it reports the start of the next kept range,
    because every caller wants "where does playback carry on from here". Use
    `dropAt` when the question is really "is this gone?". */
function srcToClip(clip, ts) {
  const rs = keptRanges(clip);
  let n = 0;
  for (let i = 0; i < rs.length; i++) {
    if (ts < rs[i][0]) return n;
    if (ts <= rs[i][1]) return n + (ts - rs[i][0]);
    n += rs[i][1] - rs[i][0];
  }
  return n;
}

/** The dropped range a source time falls in, or null. */
function dropAt(clip, ts) {
  return (clip && (clip.drops || []).find(d => ts >= d[0] && ts < d[1])) || null;
}

/** The segment a source time falls in — bounded by the split points either
    side, or by the clip's own ends. This is what "drop this bit" acts on. */
function segmentAt(clip, ts) {
  if (!clip) return null;
  const a = clip.in || 0;
  const b = clip.out == null ? (clip.srcDuration || 0) : clip.out;
  if (!(ts >= a && ts <= b)) return null;
  const edges = [a, ...(clip.marks || []).filter(m => m > a && m < b), b]
    .sort((x, y) => x - y);
  for (let i = 0; i < edges.length - 1; i++) {
    if (ts >= edges[i] && ts < edges[i + 1]) return [edges[i], edges[i + 1]];
  }
  return [edges[edges.length - 2], edges[edges.length - 1]];
}

/** Put a segment back. Ranges are kept whole rather than merged, so each one
    restores on its own however many sit side by side. */
function undropAt(clip, ts) {
  const i = (clip.drops || []).findIndex(d => ts >= d[0] && ts < d[1]);
  if (i < 0) return false;
  clip.drops.splice(i, 1);
  return true;
}

/** A new AudioBuffer holding just [inS, outS). Constructed rather than copied
    sample by sample in JS — subarray + copyToChannel is one memcpy a channel. */
function sliceBuffer(buf, inS, outS) {
  const sr = buf.sampleRate;
  const a = clamp(Math.round((inS || 0) * sr), 0, buf.length);
  const b = clamp(Math.round((outS == null ? buf.duration : outS) * sr), a + 1, buf.length);
  if (a === 0 && b === buf.length) return buf;
  const n = b - a;
  let out;
  try {
    out = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: buf.numberOfChannels });
  } catch (e) {
    // Older Safari has no AudioBuffer constructor; an offline context makes one.
    out = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      buf.numberOfChannels, n, sr).createBuffer(buf.numberOfChannels, n, sr);
  }
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  }
  return out;
}

/** The kept ranges, concatenated into one buffer. One range is the old
    single-slice path untouched; several is a butt join per range, which is what
    a cut is — no crossfade, because a cut placed in a pause does not need one
    and one placed mid-word should be heard for what it is. */
function sliceRanges(buf, ranges) {
  if (ranges.length <= 1) {
    const r = ranges[0] || [0, buf.duration];
    return sliceBuffer(buf, r[0], r[1]);
  }
  const sr = buf.sampleRate;
  const spans = ranges.map(r => [
    clamp(Math.round(r[0] * sr), 0, buf.length),
    clamp(Math.round(r[1] * sr), 0, buf.length)
  ]).filter(s => s[1] > s[0]);
  const n = spans.reduce((k, s) => k + (s[1] - s[0]), 0);
  if (!n) return sliceBuffer(buf, 0, Math.min(0.05, buf.duration));
  let out;
  try {
    out = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: buf.numberOfChannels });
  } catch (e) {
    out = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      buf.numberOfChannels, n, sr).createBuffer(buf.numberOfChannels, n, sr);
  }
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    let at = 0;
    spans.forEach(s => { out.copyToChannel(src.subarray(s[0], s[1]), c, at); at += s[1] - s[0]; });
  }
  return out;
}

/** A cheap min/max summary of the WHOLE source, for the trim strip. A few
    hundred buckets — kilobytes — so a cold clip can keep it and still cost
    nothing. */
function buildPeaks(buf, buckets) {
  const N = buckets || 900;
  const d = buf.getChannelData(0);
  const out = new Float32Array(N * 2);
  const per = d.length / N;
  for (let i = 0; i < N; i++) {
    const a = Math.floor(i * per), b = Math.min(d.length, Math.floor((i + 1) * per));
    let mn = 0, mx = 0;
    const step = Math.max(1, Math.floor((b - a) / 240));
    for (let k = a; k < b; k += step) { const v = d[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[i * 2] = mn; out[i * 2 + 1] = mx;
  }
  return out;
}
const clipById = id => queue.clips.find(c => c.id === id) || null;

let clipSeq = 0;
function newClip(file) {
  return {
    id: 'c' + (++clipSeq), file, name: file.name.replace(/\.[^.]+$/, ''),
    // in/out are SECONDS INTO THE SOURCE FILE, not frames: a frame index is
    // only meaningful at one frame rate, and both trimming and changing the
    // rate move what a frame number means. srcDuration is the whole file.
    in: 0, out: null, srcDuration: 0, peaks: null,
    // Split points waiting to be committed, in seconds of the source. Marking
    // them all first and cutting once is the difference between "put a break
    // between each speaker" and "cut, hunt for the right piece, cut again".
    marks: [],
    // Bits between split points that were thrown away, as [a, b] in source
    // seconds. The clip's material is `in`..`out` minus these.
    drops: [],
    // The geometry the current frames and keys were built against. The handles
    // mutate `in` as they are dragged, so the old shape has to be remembered
    // somewhere they cannot reach, or the keys move by nothing.
    appliedIn: 0, appliedGeom: null,
    duration: 0, frames: [], script: [], dirty: false,
    overlay: { x: 0.5, y: 0.66, size: 0.30, rot: 0, keyed: false, keys: [] },
    puppetPose: { x: 0.5, y: 0.5, size: 1, rot: 0 },
    layers: null,
    canvas: null,
    boil: null,
    patch: { on: false, blur: 0.35, cover: 1.25 },
    mirror: { lips: false, plate: false },
    style: null, lipSetId: null,        // null = whatever is chosen globally
    // Which cast member is speaking this line. The settings above are still
    // the truth — this only says which chip they came from, so the queue can
    // show it and so re-assigning a character is one click rather than six.
    cast: null,
    video: null, analysed: false, error: null
  };
}

/** Copy what is live back into the record, so nothing is lost on a switch. */
function bankClip() {
  const c = activeClip();
  if (!c) return;
  c.frames = state.frames;
  c.script = state.script;
  c.dirty = state.dirty;
  c.duration = state.buffer ? state.buffer.duration : c.duration;
  c.video = state.video;
  c.analysed = state.frames.length > 0;
  c.overlay = JSON.parse(JSON.stringify(overlay));
  c.puppetPose = { ...puppetPose };
  c.layers = layers.map(L => ({ ...L }));
  c.canvas = { ...canvasSetting };
  c.boil = { ...boil };
  c.patch = { ...patch };
  c.mirror = { ...mirror };
  c.style = state.style;
  c.lipSetId = lips.activeId;
  c.cast = activeShelfId();
  // c.puppet is not touched here. It holds the File, not the decoded picture —
  // a dozen photographs held decoded at once is how a session ends on an iPad —
  // and it is written where the choice is made, by setPuppet and forgetPuppet.
}

/** And the other direction, for everything that is not the audio itself. */
function applyClipSettings(c) {
  Object.assign(overlay, JSON.parse(JSON.stringify(c.overlay)));
  // A clip banked before the puppet could be placed has no record of one, and
  // a missing record means "filling the frame", not "keep the last clip's".
  Object.assign(puppetPose, PUPPET_POSE, c.puppetPose || {});
  // Layers belong to the clip, like the lips and the placement: a two-hander
  // split into lines can have a caption on one and a prop on the next.
  layers = (c.layers || []).map(L => ({ ...L }));
  selectedLayerId = null;
  layerEditorId = null;
  // A clip that has never had a canvas set takes the last one CHOSEN rather
  // than falling back to match-the-puppet: setting 1920×1080 and then loading
  // another take, or clearing the audio and loading a new one, used to throw
  // the format away silently.
  Object.assign(canvasSetting, { mode: 'auto', w: 1920, h: 1080 },
                canvasPreference || {}, c.canvas || {});
  Object.assign(boil, BOIL_DEFAULT, c.boil || {});
  Object.assign(patch, c.patch);
  // Clips banked before the mirrors existed have no record of them, and a
  // missing record means "not mirrored" rather than "leave the last clip's".
  Object.assign(mirror, { lips: false, plate: false }, c.mirror || {});
  if (c.lipSetId && lipSetById(c.lipSetId)) {
    useLipSet(c.lipSetId);
  } else if (c.style) {
    state.style = c.style; custom.on = false; custom.map = {}; custom.sources = [];
    lips.activeId = null;
    buildStyleChips(); buildLipChips();
  }
  syncPatchUI();
  // Each clip gets its own history, replaced rather than added to: undoing
  // past the moment a clip was opened would restore another clip's stack.
  resetStageHistory();
  // Not awaited — applyClipSettings is called from places that cannot wait,
  // and the stage redraws itself when the picture lands. But an EXPORT has to
  // wait, or it composes the first frames of a clip before its puppet has
  // decoded: the frame comes out the wrong shape (plateCellSize falls back to
  // a square when there is no plate to measure) and the opening frames come
  // out with no character in them at all. So the promise is kept where an
  // export can find it.
  plateReady = restorePuppet(c);
}

async function openClip(id, opts) {
  const c = clipById(id);
  if (!c || (queue.activeId === id && !(opts && opts.force))) return c;
  if (queue.activeId && queue.activeId !== id) bankClip();
  queue.activeId = id;
  renderQueue();
  await loadFile(c.file, c);
  return c;
}

/** Files in. The first one opens; the rest wait, because analysing twenty
    clips nobody has looked at yet is minutes of work for no one. */
async function addFiles(files) {
  const list = [...files].filter(f => !f.type.startsWith('image/'));
  if (!list.length) return;
  const room = BATCH_MAX_CLIPS - queue.clips.length;
  if (room <= 0) {
    toast('The queue holds ' + BATCH_MAX_CLIPS + ' clips. Export or remove some first.', 5000);
    return;
  }
  const taking = list.slice(0, room);
  if (taking.length < list.length) {
    toast('Taking ' + taking.length + ' of ' + list.length + ' — the queue holds ' +
          BATCH_MAX_CLIPS + '.', 5000);
  }
  const first = queue.clips.length === 0;
  const added = taking.map(f => { const c = newClip(f); queue.clips.push(c); return c; });
  renderQueue();
  await openClip(added[0].id, { force: first });
  renderQueue();
  // A fresh file is the floor of the timeline's undo stack: there is nothing
  // sensible to take back past "this is what was loaded".
  resetTimeHistory();
}

function removeClip(id) {
  // Snapshot on the next tick: this has three exits and openClip's own
  // bookkeeping runs after it, so what the queue BECAME is only true once
  // this turn of the loop is over.
  if (clipById(id)) setTimeout(pushTimeHistory, 0);
  playAllStop(true);
  const at = queue.clips.findIndex(c => c.id === id);
  if (at < 0) return;
  const wasActive = queue.activeId === id;
  queue.clips.splice(at, 1);
  if (!wasActive) { renderQueue(); updateBatchUI(); return; }
  queue.activeId = null;
  if (!queue.clips.length) { clearAudio(); renderQueue(); updateBatchUI(); return; }
  openClip(queue.clips[Math.min(at, queue.clips.length - 1)].id);
}

function clearQueue() {
  playAllStop(true);
  queue.clips = [];
  queue.activeId = null;
  clearAudio();
  renderQueue();
  resetTimeHistory();
}

/* --- the trim strip -------------------------------------------------------

   Draws the WHOLE source: kept range bright, trimmed ends shaded, handles at
   the edges, playhead where you are. Everything is in seconds of the source;
   the sheet next door is in frames of the trimmed clip, and the two are never
   mixed.
--------------------------------------------------------------------------- */

const HANDLE_PX = 9;

/* Split points are grabbed by their flag, in a lane across the top of the
   waveform, and nowhere else.

   The first version tested a press against every mark's x position across the
   full height, ±9px, and removed the nearest hit. On the nine-second fixture
   with three points that is 6% of the widget and it felt fine. On a real job —
   measured, a 2:39 recording with 34 points from "Find the pauses" — each point
   owns 18px of a 946px widget, so 65% of the waveform destroys a split point
   instead of seeking. Two presses in three. That is not a tolerance that needs
   tuning; a plain press must not destroy anything, whatever the density.

   So the flags live in the top MARK_LANE pixels, which is also where they are
   drawn. Below the lane the whole waveform seeks, even directly on a line. */
const MARK_LANE = 15;
const MARK_GRAB_PX = 7;
/* The division between two pieces is grabbed in the same lane, and wins ties
   against a marker: a marker can be put back with one press, a cut that moved
   by accident takes two clips re-analysing. */
const EDGE_GRAB_PX = 8;
let trimDrag = null;      // 'in' | 'out' | 'scrub' | 'mark' | 'edge'
let markDrag = null;      // which marker is in hand, and whether it moved
let edgeDrag = null;      // which division between two pieces is in hand

/* ---- one file, several pieces, one timeline ------------------------------

   Splitting used to make the rest of the file DISAPPEAR. Each piece became a
   clip of its own, the timeline showed the open one, and everything either
   side of it was shaded like material that had been trimmed away — so cutting
   a four-line conversation into four looked like three quarters of the
   recording had been thrown in the bin. Reported as exactly that.

   Nothing was lost; the picture was wrong. The timeline is already a picture
   of the WHOLE source file, which is what makes this cheap: the other pieces
   are drawn where they have always been, with a division between them, named,
   and pressing one opens it. That is a cut list, which is what an editor
   expects a timeline after a split to be — and because opening a piece brings
   its own puppet and lips with it, moving along the file shows each character
   in turn on the stage.
--------------------------------------------------------------------------- */

const clipOut = c => (c && c.out == null ? (c && c.srcDuration) || 0 : c.out);

/** Every clip cut from one file, in the order they run. */
function fileFamily(clip) {
  if (!clip) return [];
  if (!clip.file) return [clip];
  return queue.clips.filter(c => c.file === clip.file)
                    .sort((a, b) => (a.in || 0) - (b.in || 0));
}

/** The divisions: pairs of pieces that meet, left to right. Two pieces that
    do NOT meet — because the stretch between them was trimmed off — have no
    division, because there is no single cut to drag. */
function fileEdges(clip) {
  const fam = fileFamily(clip);
  const out = [];
  for (let i = 0; i < fam.length - 1; i++) {
    if (Math.abs(clipOut(fam[i]) - (fam[i + 1].in || 0)) < 0.002) {
      out.push({ left: fam[i], right: fam[i + 1], t: clipOut(fam[i]) });
    }
  }
  return out;
}

/** This clip's analysis no longer describes it. Used on a piece that is not
    open when its edge moves: the frames belonged to the old length, and the
    honest thing is to drop them and let it analyse when it is next opened. */
function staleClip(c) {
  if (!c) return;
  c.frames = []; c.analysed = false; c.dirty = false;
  c.appliedGeom = null; c.appliedIn = c.in || 0;
  c.duration = keptDuration(c);
}

/* Which surface the last gesture was on.

   Three things have undo now — the sheet, the stage and the timeline — and
   one ⌘Z between them. The sheet and the stage arbitrate by recency, which
   works because an edit to either is a visible thing that just happened. The
   timeline cannot join that race: re-cutting a clip is slow and loud, and
   having it answer a ⌘Z aimed at a mouth shape would be awful. So it answers
   only when it is literally the thing in hand. */
let lastSurface = 'sheet';
const timelineInHand = () => lastSurface === 'timeline';

/* ---- undo on the timeline ------------------------------------------------

   The sheet has had undo for a long time and the stage got it last week; the
   timeline had none, so a split or a dropped stretch was a one-way door.

   A snapshot is the ARRAY of clips plus each one's geometry — not a copy of
   the clips. That matters: a split replaces one clip object with several, and
   holding the old object in the snapshot means undoing a split gives back the
   very clip that was cut, with its frames, its hand edits and its puppet still
   on it, rather than something that has to be analysed from scratch.
--------------------------------------------------------------------------- */
const timeHistory = { stack: [], at: -1, max: 40 };

const geomOf = c => ({
  c, in: c.in, out: c.out, name: c.name, duration: c.duration,
  marks: (c.marks || []).slice(),
  drops: (c.drops || []).map(d => d.slice()),
});

function timeSnapshot() {
  return { clips: queue.clips.slice(), activeId: queue.activeId,
           geom: queue.clips.map(geomOf) };
}

function resetTimeHistory() {
  timeHistory.stack = [timeSnapshot()];
  timeHistory.at = 0;
  syncTimeUndoUI();
}

function pushTimeHistory() {
  if (timeHistory.at < timeHistory.stack.length - 1) {
    timeHistory.stack.length = timeHistory.at + 1;   // a new branch drops the redo tail
  }
  timeHistory.stack.push(timeSnapshot());
  if (timeHistory.stack.length > timeHistory.max) timeHistory.stack.shift();
  timeHistory.at = timeHistory.stack.length - 1;
  syncTimeUndoUI();
}

function syncTimeUndoUI() {
  const u = $('timeUndo'), r = $('timeRedo');
  if (u) u.disabled = timeHistory.at <= 0;
  if (r) r.disabled = timeHistory.at >= timeHistory.stack.length - 1;
}

async function applyTimeSnapshot(s) {
  const openWas = queue.activeId;
  let reopen = s.activeId !== openWas;
  queue.clips = s.clips.slice();
  s.geom.forEach(g => {
    const moved = g.c.in !== g.in || clipOut(g.c) !== (g.out == null ? g.c.srcDuration : g.out) ||
                  JSON.stringify(g.c.drops || []) !== JSON.stringify(g.drops);
    g.c.in = g.in; g.c.out = g.out; g.c.name = g.name;
    g.c.marks = g.marks.slice();
    g.c.drops = g.drops.map(d => d.slice());
    g.c.duration = g.duration;
    if (moved) { staleClip(g.c); if (g.c.id === s.activeId) reopen = true; }
  });
  queue.activeId = s.activeId;
  renderQueue();
  updateBatchUI();
  if (!queue.clips.length) { clearAudio(); return; }
  if (reopen || !clipById(openWas)) {
    queue.activeId = null;
    await openClip(s.activeId || queue.clips[0].id, { force: true });
  } else {
    trimReadout(); drawTrim(); drawStage();
  }
  syncTimeUndoUI();
}

async function timeUndo() {
  if (timeHistory.at <= 0) return;
  timeHistory.at--;
  await applyTimeSnapshot(timeHistory.stack[timeHistory.at]);
  toast('Timeline: undone.', 1600);
}

async function timeRedo() {
  if (timeHistory.at >= timeHistory.stack.length - 1) return;
  timeHistory.at++;
  await applyTimeSnapshot(timeHistory.stack[timeHistory.at]);
  toast('Timeline: redone.', 1600);
}

function trimBarVisible(on) {
  const el = $('trimBar');
  if (el) el.hidden = !on;
}

/** The trim picture and the exposure sheet's overview are now the same canvas:
    one waveform, drawn once, big enough to work on. Kept as its own name
    because a dozen call sites talk about trimming, not about the sheet. */
function drawTrim() { drawOverview(); }

/* ---- markers and cuts ----------------------------------------------------

   These were one thing and are now two, because they were one thing by
   accident. A "split point" was a bookmark that a separate button later cut
   at, which meant the common job — "cut here, now" — took two presses and a
   concept, and the uncommon job — "remember this spot" — could not be had at
   all without threatening a cut.

   A MARKER (M) is a bookmark. It cuts nothing.
   SPLIT (B) cuts at the playhead, immediately, like every editor's blade.

   They meet in one place: a split lands on a marker if there is one within a
   few frames, so marking up a conversation and then cutting through it is
   still one gesture per line. */

/** How close the playhead has to be to a marker for a cut to land on it. */
const MARK_SNAP = 0.15;

/** Put a marker where the playhead is. */
function markAtPlayhead() {
  const clip = activeClip();
  if (!clip || !state.buffer) return false;
  if (addMark(clip, clipToSrc(clip, playTime()))) {
    trimReadout(); drawTrim(); pushTimeHistory();
    return true;
  }
  toast('Move the playhead away from the ends, or from a marker already there.', 3000);
  return false;
}

/** Cut the open clip in two at the playhead. Returns how many pieces it made.*/
function splitAtPlayhead() {
  const clip = activeClip();
  if (!clip || !state.buffer) return 0;
  let t = clipToSrc(clip, playTime());
  const near = (clip.marks || []).find(m => Math.abs(m - t) < MARK_SNAP);
  if (near != null) t = near;
  const a = clip.in || 0, b = clipOut(clip);
  if (!(t > a + 0.15 && t < b - 0.15)) {
    toast('Move the playhead into the clip — there is nothing to cut at the very ends.', 3500);
    return 0;
  }
  // A marker the cut has just landed on has done its job and would otherwise
  // sit on the new clip's first frame, where it can never be cut at again.
  clip.marks = (clip.marks || []).filter(m => Math.abs(m - t) >= MARK_SNAP);
  const n = splitClipAt(clip, [t]);
  if (n) pushTimeHistory();
  return n;
}

/** Put the pieces of one file back together. "Whole file" used to reach only
    the open clip's own handles, which on a file that had been split meant it
    announced the whole file and gave back one piece of it — and the clips
    strip stayed, still listing the others. */
async function unsplitFile(clip) {
  const fam = fileFamily(clip);
  if (fam.length < 2) {
    clip.in = 0; clip.out = clip.srcDuration; clip.drops = []; clip.marks = [];
    await applyTrim(clip);
    pushTimeHistory();
    return 1;
  }
  // The open piece is the survivor, so the stage does not change character
  // under you: it keeps its puppet, its lips and its layers, and grows to the
  // whole file.
  const keep = clip;
  keep.in = 0; keep.out = keep.srcDuration; keep.drops = []; keep.marks = [];
  keep.name = (keep.file && keep.file.name || 'clip').replace(/\.[^.]+$/, '');
  queue.clips = queue.clips.filter(c => c.file !== keep.file || c === keep);
  staleClip(keep);
  renderQueue();
  await applyTrim(keep);
  renderQueue();
  updateBatchUI();
  pushTimeHistory();
  return fam.length;
}

/** Open another piece of the same file and stand at the moment that was
    pressed, so moving along the timeline moves along the recording rather
    than jumping back to the head of whatever opened. */
async function openPieceAt(c, srcT) {
  if (!c) return;
  await openClip(c.id, { force: false });
  const lo = c.in || 0, hi = clipOut(c);
  const t = srcToClip(c, clamp(srcT, lo, hi));
  const dur = state.buffer ? state.buffer.duration : 0;
  seekTo(clamp(t, 0, Math.max(0, dur - 0.001)));
  const i = clamp(Math.round(t * state.fps), 0, Math.max(0, state.frames.length - 1));
  state.sel = state.selEnd = i;
  updateSelReadout();
  drawSheet(); drawStage(); drawOverview();
}

/** Markers must sit inside the kept range and not on top of each other. */
function addMark(clip, t) {
  const a = clip.in || 0, b = clip.out == null ? clip.srcDuration : clip.out;
  if (!(t > a + 0.15 && t < b - 0.15)) return false;
  if ((clip.marks || []).some(m => Math.abs(m - t) < 0.12)) return false;
  clip.marks = [...(clip.marks || []), +t.toFixed(4)].sort((x, y) => x - y);
  return true;
}

function trimReadout() {
  const clip = activeClip();
  const el = $('trimRead');
  if (!el || !clip) return;
  const a = clip.in || 0, b = clip.out == null ? clip.srcDuration : clip.out;
  const n = (clip.marks || []).length;
  const fam = fileFamily(clip).length;
  const dropped = (clip.drops || []);
  const gone = dropped.reduce((k, d) => k + (d[1] - d[0]), 0);
  el.textContent = (isTrimmed()
    // The kept length has to come from the ranges, not from out minus in, or a
    // clip with a bit taken out of the middle overstates how long it is.
    ? fmtTime(a) + ' → ' + fmtTime(b) + '  (' + fmtTime(keptDuration(clip)) +
      ' of ' + fmtTime(clip.srcDuration) + ')'
    : 'whole file · ' + fmtTime(clip.srcDuration))
    + (n ? '  ·  ' + n + ' marker' + (n === 1 ? '' : 's') : '')
    + (dropped.length ? '  ·  ' + dropped.length + ' bit' + (dropped.length === 1 ? '' : 's') +
       ' dropped (' + fmtTime(gone) + ')' : '')
    + (fam > 1 ? '  ·  piece ' + (fileFamily(clip).indexOf(clip) + 1) + ' of ' + fam : '');
  // Whole file is live whenever there is anything to put back: a trim, a drop,
  // or the other pieces of a file that has been split.
  $('trimReset').disabled = !isTrimmed() && fam < 2;
  // The count goes in the tooltip rather than the label: the row is already
  // eight buttons wide and a label that grows pushes Delete onto a line of
  // its own. The readout beside it already says "piece 2 of 3".
  $('trimReset').title = fam > 1
    ? 'Put the ' + fam + ' pieces of this file back into one clip'
    : 'Undo the trim and bring back every dropped stretch';
  $('trimCommit').hidden = !n;
  $('trimClear').hidden = !n;
  $('trimCommit').textContent = 'Split at markers';
  const sp = $('trimSplit');
  if (sp) sp.disabled = !state.buffer;
  // Dropping needs somewhere to put the playhead that is not the whole clip:
  // with no marker down there is only one segment, and dropping it would
  // leave nothing behind. Trim the ends for that.
  const drop = $('trimDrop');
  if (drop) drop.disabled = !n && !dropped.length;
}

/** How many clips a split would make: one per segment that still has material
    in it. A segment that has been dropped does not become a clip. */
function segmentsKept(clip) {
  if (!clip) return 0;
  const a = clip.in || 0, b = clip.out == null ? clip.srcDuration : clip.out;
  const edges = [a, ...(clip.marks || []).filter(m => m > a && m < b), b].sort((x, y) => x - y);
  let n = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const mid = (edges[i] + edges[i + 1]) / 2;
    if (!dropAt(clip, mid)) n++;
  }
  return n;
}

/** Re-slice and re-analyse after the handles move. The file is not read again;
    the whole decoded source is still in hand while this clip is open. */
async function applyTrim(clip) {
  if (!clip || !state.srcBuffer) return;
  // The shape the current keys were built against, so they can be carried over
  // to the new one. `appliedIn` alone was enough while a trim could only move
  // the origin; a drop reshuffles the middle, so the whole geometry is kept.
  const before = clip.appliedGeom ||
    { in: clip.appliedIn || 0, out: clip.out, srcDuration: clip.srcDuration, drops: [] };
  clip.out = Math.min(clip.out == null ? clip.srcDuration : clip.out, clip.srcDuration);
  clip.in = clamp(clip.in || 0, 0, Math.max(0, clip.out - 0.05));
  working(true, 'Trimming…');
  await paintNow();
  stopPlayback();
  const ranges = keptRanges(clip);
  state.buffer = sliceRanges(state.srcBuffer, ranges);
  await rebuildMono();
  state.frames = []; state.dirty = false;
  $('tTotal').textContent = fmtTime(state.buffer.duration);
  seekTo(0);
  await runAnalysis();
  clip.frames = state.frames;
  clip.duration = state.buffer.duration;
  clip.appliedIn = clip.in;
  clip.appliedGeom = { in: clip.in, out: clip.out, srcDuration: clip.srcDuration,
                       drops: (clip.drops || []).map(d => d.slice()) };
  clip.analysed = state.frames.length > 0;
  setLooping(looping);
  trimReadout(); drawTrim(); renderQueue();
  working(false);
}

/** The mono working copy, from whatever state.buffer currently is. */
async function rebuildMono() {
  const audio = state.buffer;
  const n = audio.length;
  const mono = new Float32Array(n);
  const SLICE = 1 << 21;
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < n; i += SLICE) {
      const end = Math.min(n, i + SLICE);
      for (let k = i; k < end; k++) mono[k] += d[k];
      if (n > SLICE) await new Promise(r => setTimeout(r, 0));
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) { mono[i] /= audio.numberOfChannels; const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak > 0.02) for (let i = 0; i < n; i++) mono[i] /= peak;
  state.mono = mono;
}

/* --- splitting ------------------------------------------------------------

   A split makes several clips out of one, all sharing the same File with
   different in/out. Nothing is copied and nothing is re-read: a piece costs a
   record. Each piece then behaves exactly like a separately loaded file, which
   is what makes the batch work on them unchanged.
--------------------------------------------------------------------------- */

function splitClipAt(clip, cuts) {
  const dur = clip.srcDuration || 0;
  const a = clip.in || 0, b = clip.out == null ? dur : clip.out;
  let pts = [...new Set(cuts.map(t => +t.toFixed(4)))]
    .filter(t => t > a + 0.15 && t < b - 0.15)
    .sort((x, y) => x - y);
  if (!pts.length) return 0;
  /* The queue holds BATCH_MAX_CLIPS, and nothing used to stop a split from
     making more than that: "Find the pauses" on a long conversation would
     hand back thirty lines, the queue would take them, and batch export would
     then be quietly unable to carry the run. Cut to what the queue can hold
     and say so — the last piece keeps whatever is left, so nothing is lost,
     it is just not split any finer. */
  const room = BATCH_MAX_CLIPS - (queue.clips.length - 1);   // this clip is replaced
  if (pts.length + 1 > room) {
    const kept = Math.max(1, room - 1);
    toast('That would make ' + (pts.length + 1) + ' clips and the queue holds ' +
          BATCH_MAX_CLIPS + '. Splitting at the first ' + kept +
          ' points; the rest stays in the last piece, which you can split again.', 8000);
    pts = pts.slice(0, kept);
  }

  const at = queue.clips.indexOf(clip);
  const edges = [a, ...pts, b];
  const made = [];
  for (let i = 0; i < edges.length - 1; i++) {
    // A segment that was dropped does not become a clip. Without this a split
    // would resurrect every bit that had just been thrown away, as an empty
    // clip apiece.
    if (dropAt(clip, (edges[i] + edges[i + 1]) / 2)) continue;
    const piece = newClip(clip.file);
    piece.in = edges[i];
    piece.out = edges[i + 1];
    piece.srcDuration = dur;
    piece.peaks = clip.peaks;          // the same source, so the same picture
    // A drop that straddles a cut goes to whichever piece holds it, clipped to
    // that piece's range.
    piece.drops = (clip.drops || [])
      .map(d => [Math.max(d[0], piece.in), Math.min(d[1], piece.out)])
      .filter(d => d[1] - d[0] > 0.001);
    piece.duration = keptDuration(piece);
    // The settings you had chosen apply to every piece; the timing does not.
    // Keys were placed against the parent's origin, so they move to each
    // piece's own and only the ones that land inside it come along.
    piece.overlay = JSON.parse(JSON.stringify(clip.overlay));
    piece.appliedIn = piece.in;
    piece.appliedGeom = { in: piece.in, out: piece.out, srcDuration: dur,
                          drops: piece.drops.map(d => d.slice()) };
    piece.patch = { ...clip.patch };
    piece.style = clip.style;
    piece.lipSetId = clip.lipSetId;
    // And the rest of the setup, which used not to come along at all: split a
    // conversation into thirty lines and you got thirty pieces with no head on
    // any of them, no layers, and the canvas back at Match-the-puppet. The
    // settings apply to every piece for the same reason the lips do — they
    // were chosen for this material, and the cut did not change the material.
    // Assigning a speaker per line comes AFTER this, on top of a working
    // starting point rather than instead of one.
    piece.puppet = clip.puppet ? { ...clip.puppet } : null;
    piece.cast = clip.cast || null;
    piece.puppetPose = { ...clip.puppetPose };
    piece.layers = clip.layers ? clip.layers.map(L => ({ ...L })) : null;
    piece.canvas = clip.canvas ? { ...clip.canvas } : null;
    piece.boil = clip.boil ? { ...clip.boil } : null;
    piece.mirror = { ...clip.mirror };
    made.push(piece);
  }
  if (!made.length) return 0;
  queue.clips.splice(at, 1, ...made);
  // Numbering has to be done across every clip cut from this file, not within
  // the one being split — splitting a piece a second time otherwise mints a
  // second "-01" and two exports fight over the same filename.
  renumberSplits(clip.file);
  queue.activeId = null;
  renderQueue();
  openClip(made[0].id, { force: true });
  toast('Split into ' + made.length + ' clips.', 3000);
  return made.length;
}

/** One numbering for all the pieces of a file, in the order they play. */
function renumberSplits(file) {
  const kin = queue.clips.filter(c => c.file === file);
  if (kin.length < 2) return;
  const stem = (file.name || 'clip').replace(/\.[^.]+$/, '');
  kin.slice().sort((a, b) => (a.in || 0) - (b.in || 0))
     .forEach((c, i) => { c.name = stem + '-' + String(i + 1).padStart(2, '0'); });
}

/** Cut where the analyser already heard silence. The X runs are sitting in
    state.frames, so this costs nothing beyond reading them. */
function silenceCuts(minRestSeconds) {
  if (!state.frames.length) return [];
  const fps = state.fps, need = Math.max(1, Math.round(minRestSeconds * fps));
  // The frames are clip time; a split point is source time. With a bit dropped
  // out of the middle those are no longer a constant apart.
  const clip = activeClip();
  const cuts = [];
  let run = 0;
  for (let i = 0; i < state.frames.length; i++) {
    if (state.frames[i].v === 'X') { run++; continue; }
    if (run >= need && i - run > 0) cuts.push(clipToSrc(clip, (i - run / 2) / fps));
    run = 0;
  }
  return cuts;
}

/* --- the list ------------------------------------------------------------- */

/** A clip the batch will take its time over. Worked out from the duration
    rather than stored on the clip, so a piece cut by a split answers the same
    way as a file that was loaded — the stored flag was only ever set by
    `loadFile`, which meant a split clip nobody had opened yet looked short
    right up until the run reached it. */
const clipIsLong = c =>
  !!c && queue.clips.length > 1 && (c.duration || 0) > BATCH_MAX_SECONDS;

function clipStatus(c) {
  if (c.error) return { cls: 'bad', label: c.error };
  if (c.id === queue.activeId) return { cls: 'live', label: 'open' };
  if (clipIsLong(c)) return { cls: 'long', label: 'long — slower in a batch, but it does export' };
  if (c.analysed) return { cls: 'done', label: c.dirty ? 'edited' : 'analysed' };
  return { cls: 'idle', label: 'queued' };
}

function renderQueue() {
  const wrap = $('queue');
  if (!wrap) return;
  // The one place every change to what is loaded passes through, so the demo
  // button's two states are decided here rather than at each call site.
  syncDemoBtn();
  const many = queue.clips.length > 1;
  $('queueWrap').hidden = !many;
  $('loaded').classList.toggle('on', queue.clips.length === 1);
  if (many) $('drop').style.display = 'none';
  $('queueCount').textContent = queue.clips.length + ' clips';
  wrap.innerHTML = '';
  queue.clips.forEach((c, i) => {
    const st = clipStatus(c);
    const row = document.createElement('div');
    row.className = 'qrow' + (c.id === queue.activeId ? ' on' : '');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = c.file.name + ' — ' + st.label;
    const n = document.createElement('span');
    n.className = 'qname';
    n.textContent = (i + 1) + '. ' + c.name;
    const m = document.createElement('span');
    m.className = 'qmeta mono';
    m.textContent = c.duration ? fmtTime(c.duration) : '—';
    const lip = clipLipThumb(c);
    // Who is speaking this line, if anyone has been cast. Before the queue is
    // cast there is nothing to show and the row keeps the width.
    const who = document.createElement('span');
    const ce = c.cast && castEntry(c.cast);
    if (ce) {
      who.className = 'qcast';
      who.title = ce.label;
      const t = castThumbEl(ce, false);
      if (t) who.appendChild(t);
    }
    const d = document.createElement('span');
    d.className = 'qdot ' + st.cls;
    const x = document.createElement('button');
    x.className = 'qx';
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Take this clip out of the queue';
    x.onclick = e => { e.stopPropagation(); removeClip(c.id); };
    row.append(d, who, lip, n, m, x);
    row.onclick = () => { playAllStop(true); openClip(c.id); };
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClip(c.id); } };
    wrap.appendChild(row);
  });
  updateBatchUI();
  updateStyleScope();
  renderCastBar();
  syncPlayAllUI();
}

/** The mouth a clip will be drawn with, as a picture on its queue row. The
    open clip is asked about the live style rather than its record, since the
    record is only written when you switch away. */
function clipLipThumb(c) {
  const cv = document.createElement('canvas');
  cv.className = 'qlips';
  cv.width = 52; cv.height = 38;
  const live = c.id === queue.activeId;
  const setId = live ? lips.activeId : c.lipSetId;
  const styleId = live ? state.style : c.style;
  cv.title = 'Lips: ' + clipLipName(c);
  const ctx = cv.getContext('2d');
  ctx.setTransform(1.35, 0, 0, 1.35, -0.16 * 52, -0.16 * 38);
  try {
    const set = setId && lipSetById(setId);
    // Straight from the set's own art, the way the chips do it — the row has to
    // show that clip's lips whether or not that set is the one in use.
    const src = set && (set.map.C || set.map.A || Object.values(set.map)[0]);
    if (src && src.img) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const s = Math.min(52 / src.sw, 38 / src.sh);
      ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh,
                    (52 - src.sw * s) / 2, (38 - src.sh * s) / 2, src.sw * s, src.sh * s);
    } else if (STYLES[styleId || state.style]) {
      STYLES[styleId || state.style].draw(ctx, 52, 38, 'C');
    }
  } catch (e) {}
  return cv;
}

function clipLipName(c) {
  const live = c.id === queue.activeId;
  const setId = live ? lips.activeId : c.lipSetId;
  const styleId = live ? state.style : c.style;
  const set = setId && lipSetById(setId);
  if (set) return set.name || 'custom';
  const s = STYLES[styleId || state.style];
  return s ? s.label : '—';
}

/** Say that the picker belongs to the open clip, and offer the two ways of
    spreading a choice across a queue that are actually worth having. */
function updateStyleScope() {
  const bar = $('styleScopeBar');
  if (!bar) return;
  const many = queue.clips.length > 1;
  bar.hidden = !many;
  const scope = $('styleScope');
  if (scope) { scope.hidden = !many; scope.textContent = many ? 'Per clip' : ''; }
  if (!many) return;
  const c = activeClip();
  const i = queue.clips.findIndex(x => x.id === queue.activeId);
  $('styleScopeText').innerHTML = c
    ? 'These lips belong to <b>' + xmlEsc(c.name) + '</b> — clip ' + (i + 1) +
      ' of ' + queue.clips.length + '. Open another clip to give it different ones.'
    : 'These lips belong to whichever clip is open.';
}

/* --- casting a conversation ---------------------------------------------------

   Split on the pauses and you have one clip per line. The thing you then want
   is not "set the puppet thirty times", it is "Alice, Bob, Alice, Bob". So:
   write a cast member onto a clip RECORD without opening it, and deal the cast
   round the queue in turn.

   Writing to the record rather than opening each clip is the whole trick.
   Opening a clip decodes its audio, re-runs the analyser and redraws the
   stage; doing that thirty times to set thirty puppets takes minutes and
   leaves the queue on whichever clip was last. The record is what an export
   reads anyway — `applyClipSettings` puts it back when the clip is opened for
   real — so writing it directly is both faster and more honest.
--------------------------------------------------------------------------- */

/** Put a cast member on one clip's record. Returns false for a chip that is
    not a loadable puppet — a drawn face has no File until it is drawn, so it
    is made here, once, and reused. */
async function castOnto(clip, castId) {
  const e = castEntry(castId);
  if (!clip || !e) return false;
  let file = e.file;
  if (!file && e.kind === 'drawn') {
    // Drawn once and kept, so dealing a face round twelve clips is one canvas,
    // not twelve. The File is what every downstream path expects.
    if (!e.drawnFile) e.drawnFile = await faceFile(e.faceKind);
    file = e.drawnFile;
  }
  if (!file) return false;
  clip.cast = castId;
  clip.puppet = { file, kind: 'image', uncropped: e.uncropped || null,
                  cropBox: e.cropBox || null };
  // The clip is not open, so there is no decoded picture to measure: the
  // frame comes off the clip's own canvas record and the picture's size off
  // the cast entry, which setPuppet writes when the puppet first arrives. A
  // character with a remembered pose keeps it — that was a real placement on
  // a real frame — and only a first outing is fitted.
  const castFrame = castClipFrame(clip);
  const castPic = e.kind === 'drawn' ? { w: FACE_W, h: FACE_H }
                                     : (e.w && e.h ? { w: e.w, h: e.h } : null);
  const fitted = { ...PUPPET_POSE, size: fitSizeFor(castFrame, castPic) };
  clip.puppetPose = e.pose ? { ...PUPPET_POSE, ...e.pose } : fitted;
  clip.mirror = { lips: false, plate: false, ...(e.mirror || {}) };
  if (e.mouth) {
    clip.overlay = {
      ...clip.overlay,
      x: e.mouth.x, y: e.mouth.y, size: e.mouth.size, rot: e.mouth.rot || 0
    };
    // The keyframes are NOT carried. They are timings against this line's
    // audio, and a character's remembered keys belong to whatever line they
    // were set on — stamping them onto a different line moves the mouth to a
    // beat that is not there.
  } else if (e.kind === 'drawn' && FACES[e.faceKind]) {
    const P = onPuppetPlace({ ...FACES[e.faceKind].place, rot: 0 },
                            clip.puppetPose, castFrame, castPic);
    clip.overlay = { ...clip.overlay, x: P.x, y: P.y, size: P.size, rot: 0 };
  }
  if (e.lips) {
    clip.style = e.lips.style || clip.style;
    clip.lipSetId = e.lips.lipSetId || null;
  } else if (e.kind === 'drawn' && FACES[e.faceKind]) {
    const id = styleViewId(FACES[e.faceKind].style, 'front');
    if (STYLES[id]) { clip.style = id; clip.lipSetId = null; }
  }
  return true;
}

/** Deal the given cast round the queue in turn: the first clip gets the first
    one, the second the second, and round again. Two names is a two-hander;
    three is a scene. */
async function castAlternate(ids) {
  const list = (ids || []).filter(id => castEntry(id));
  if (list.length < 1 || !queue.clips.length) return 0;
  bankClip();
  let n = 0;
  for (let i = 0; i < queue.clips.length; i++) {
    if (await castOnto(queue.clips[i], list[i % list.length])) n++;
  }
  // The open clip's record has just been written under it, so put it back on
  // the stage rather than leaving the two disagreeing. Waiting for the picture
  // to decode before the queue is redrawn is what keeps the cast bar's ring on
  // the character who is actually on the stage.
  const open = activeClip();
  if (open) {
    applyClipSettings(open);
    try { await awaitPlate(); } catch (e) { /* a puppet that will not decode is its own report */ }
    sizeStage(); drawStage();
  }
  renderQueue();
  updateEstimates();
  return n;
}

/** What a cast member is called, for a queue row or a clip name. */
function castLabel(id) {
  const e = castEntry(id);
  return e ? (e.label || 'character') : null;
}

/* ---- the cast bar -------------------------------------------------------- */

/** Who is in the scene, in the order their first line comes up — read off the
    queue rather than kept in a list of its own.

    There used to be a ticked list here, and it was the wrong idea. The cast
    bar's faces and the puppet row's faces are the same pictures at the same
    size, so clicking one of them obviously means "this character, now" — but
    the bar's chips only wrote a name into the running order, which looks
    exactly like a dead button: "I click on the face, but it does not switch to
    it." A face now does one thing wherever it is clicked, and the running
    order is a thing you can see on the queue instead of a thing you have to
    remember you ticked. */
function castRunningOrder() {
  const out = [];
  queue.clips.forEach(c => {
    if (c.cast && castEntry(c.cast) && out.indexOf(c.cast) < 0) out.push(c.cast);
  });
  return out;
}

/** A chip-sized picture of a cast member, for the bar or a queue row. */
function castThumbEl(e, big) {
  if (!e) return null;
  if (e.kind === 'drawn') {
    const c = document.createElement('canvas');
    const S = 3, w = (big ? 30 : 17) * S, h = (big ? 34 : 19) * S;
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.scale(w / (FACE_W * 0.78), w / (FACE_W * 0.78));
    x.translate(-FACE_W * 0.11, -FACE_H * 0.055);
    drawFace(x, FACE_W, FACE_H, e.faceKind);
    return c;
  }
  const i = document.createElement('img');
  i.src = e.thumb || '';
  i.alt = '';
  return i;
}

function renderCastBar() {
  const bar = $('castBar');
  if (!bar) return;
  // One clip is not a conversation, so there is nobody to cast.
  bar.hidden = queue.clips.length < 2;
  if (bar.hidden) return;
  const pick = $('castPick');
  const open = activeClip();
  const at = queue.clips.findIndex(c => c.id === queue.activeId);
  const on = open ? (activeShelfId() || open.cast) : null;
  const order = castRunningOrder();
  pick.innerHTML = '';
  puppetShelf.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.cast = e.id;
    const mine = e.id === on;
    b.setAttribute('aria-pressed', String(mine));
    const line = open ? 'clip ' + (at + 1) : 'the open clip';
    b.title = mine
      ? e.label + ' is speaking ' + line
      : 'Put ' + e.label + ' on ' + line;
    b.setAttribute('aria-label', b.title);
    const t = castThumbEl(e, true);
    if (t) b.appendChild(t);
    // The badge is who opens the scene, second, third — not a tick. It comes
    // off the clips, so it appears as you cast them.
    const pos = order.indexOf(e.id);
    if (pos >= 0) {
      const o = document.createElement('span');
      o.className = 'ord';
      o.textContent = String(pos + 1);
      o.title = e.label + ' speaks ' + (pos === 0 ? 'first' : pos === 1 ? 'second'
                                        : 'at position ' + (pos + 1));
      b.appendChild(o);
    }
    b.onclick = () => castChip(e.id);
    pick.appendChild(b);
  });
  const deal = $('castDeal');
  deal.disabled = order.length < 1;
  deal.textContent = order.length === 1 ? 'Put on every clip' : 'Deal in turn';
  const hint = $('castHint');
  if (hint) {
    hint.textContent = order.length < 1
      ? 'Click a face to put that character on the clip you have open. Cast the ' +
        'first two lines and “Deal in turn” fills the rest.'
      : order.length === 1
        ? castLabel(order[0]) + ' is the only one cast so far. Click another face on ' +
          'another clip to make it a conversation, or “Put on every clip” to give ' +
          'them all ' + queue.clips.length + '.'
        : order.map(castLabel).join(', ') + ' — “Deal in turn” puts them round the ' +
          queue.clips.length + ' clips in that order. Each keeps its own mouth placement ' +
          'and lips; the keyframes stay with the line they were set on.';
  }
}

/** A face in the cast bar, clicked. The clip you are looking at is the one
    that changes, and it changes on the STAGE as well as in the record: a
    picture that does not move is how a working button reads as a broken
    one. */
async function castChip(id) {
  if (!castEntry(id)) return false;
  if (!activeClip()) { toast('Open a clip first, then pick who says it.', 3600); return false; }
  const ok = await useShelf(id);
  if (!ok) return false;
  markClipCast();
  renderQueue();                 // which redraws the bar, and the row's face
  return true;
}

/** Copy the open clip's lips onto others. `stride` of 2 takes every second
    clip from this one, which is the two-people-taking-turns case a split on
    the pauses produces. */
function spreadLips(stride) {
  const from = activeClip();
  if (!from) return 0;
  const at = queue.clips.findIndex(c => c.id === from.id);
  if (at < 0) return 0;
  bankClip();
  let n = 0;
  queue.clips.forEach((c, i) => {
    if (c.id === from.id) return;
    if (stride > 1 && ((i - at) % stride !== 0)) return;
    c.style = from.style;
    c.lipSetId = from.lipSetId;
    n++;
  });
  renderQueue();
  return n;
}

/* The decoded source, kept for as long as the same file is the one in hand.

   Every line of a split take points at the SAME File, so clicking down a
   conversation — or playing one all the way through — was reading the whole
   recording off disk and decoding it again for every line. The decode is the
   slow part of opening a clip and it is the same answer every time. Exactly
   one file is kept, the one in hand: a miss costs a decode, and a long
   recording held twice over is how a session ends on an iPad. */
let srcCache = { file: null };

const forgetSrcCache = () => { srcCache = { file: null }; };

async function loadFile(file, restore) {
  if (!file) return;
  const keepVideo = state.video && state.needsAudio && !/^video\//.test(file.type);
  // A second file dropped on top of a video is a different source; the cache
  // is for coming back to the same one.
  const sameFile = !keepVideo && srcCache.file === file && !!srcCache.buffer;
  try {
    stopPlayback();
    if (!keepVideo) { state.srcAudio = null; state.videoCodec = null; }
    // Up FIRST, and painted, because most of what follows blocks the page.
    working(true, sameFile ? 'Opening ' + file.name + '…' : 'Reading ' + file.name + '…');
    await paintNow();
    const raw = sameFile ? null : await file.arrayBuffer();

    if (sameFile) {
      // The element still holds this file; re-pointing it at the same blob
      // would cost a load and a metadata wait for no new information.
      state.video = srcCache.video || null;
      state.videoDecodable = srcCache.decodable !== false;
      sizeStage();
    } else if (!keepVideo) {
      if (playerURL) URL.revokeObjectURL(playerURL);
      playerURL = URL.createObjectURL(file);
      player.src = playerURL;
      player.load();
      state.video = await new Promise(res => {
        const done = () => res(player.videoWidth ? { w: player.videoWidth, h: player.videoHeight } : null);
        if (player.readyState >= 1) return done();
        player.addEventListener('loadedmetadata', done, { once: true });
        player.addEventListener('error', () => res(null), { once: true });
        setTimeout(done, 8000);
      });

      // Show the element BEFORE testing it. WebKit does not decode frames for
      // a hidden video, so probing one that is still display:none reports every
      // file as undecodable — including the ones the browser plays perfectly.
      state.videoDecodable = true;
      sizeStage();
      if (state.video) {
        await primeVideo();
        // Advisory only. The preview shows the video element itself, so you can
        // see what this is guessing at — it must never withhold an export that
        // would in fact have worked.
        state.videoDecodable = await videoYieldsFrame();
        sizeStage();
      }
    }

    // Fast path first; the capture fallback costs real time, so only pay it
    // when the container defeats the decoder.
    let audio = sameFile ? srcCache.buffer : null, why = '';
    try {
      if (!audio) audio = await decodeAudio(raw);
    } catch (e) {
      why = (e && e.message) || String(e);
      console.warn('decodeAudioData refused this file:', why);
    }
    // QuickTime containers, PCM tracks and ProRes movies routinely defeat the
    // decoder above. Demux the file ourselves and decode the sound track
    // directly — exact, and no slower than reading the bytes.
    if (!audio) {
      setAnalysing(true, 'Reading the sound track…');
      await paintNow();
      try {
        audio = await Demux.audio(raw, p => $('progressBar').style.width = (p * 60).toFixed(0) + '%');
      } catch (e2) {
        console.warn('demuxer could not read it:', e2);
        why = (e2 && e2.message) || String(e2);
      } finally { setAnalysing(false); }
    }

    // There was a third route here once: play the file through and record what
    // came past. It is gone. Being a lip-sync tool, audio that is silently a
    // fifth of a second out is a worse answer than an honest refusal, and the
    // two routes above are exact.

    if (!audio) {
      if (state.video) {
        // The picture is fine; only the audio track defeated us. Say so, and
        // let a separate audio file drive the analysis.
        state.needsAudio = true;
        $('drop').style.display = '';
        setLoadedUI(true);
        $('fileName').textContent = file.name;
        $('fileMeta').textContent = state.video.w + '×' + state.video.h + ' video · audio unreadable';
        overlayToolsVisible(true);
        drawStage();
        toast('The picture loaded, but this file\u2019s audio could not be read (' + why +
              '). Drop the audio as a separate WAV or MP3 and it will drive the mouth.', 9000);
        working(false);
        return;
      }
      throw new Error(why || 'the browser could not decode this file');
    }

    state.needsAudio = false;
    // The whole file is kept while this clip is open, so the trim handles can
    // be dragged back out without reading the file again. Only the open clip
    // holds it; a clip in the queue keeps its peaks and its in/out, which are
    // kilobytes.
    state.srcBuffer = audio;
    if (restore) {
      restore.srcDuration = audio.duration;
      if (!restore.peaks) restore.peaks = buildPeaks(audio);
      if (restore.out == null) restore.out = audio.duration;
      restore.appliedIn = restore.in || 0;
      audio = sliceBuffer(audio, restore.in || 0, restore.out);
    }
    state.buffer = audio;
    // One pass over the container: the copyable audio track, and what the
    // picture is actually encoded with.
    if (sameFile) {
      state.srcAudio = srcCache.srcAudio || null;
      state.videoCodec = srcCache.videoCodec || null;
    } else {
      try {
        const copied = Demux.passthrough(raw);
        if (copied) state.srcAudio = copied;
      } catch (e) { /* not an MP4-family container, or nothing copyable in it */ }
      if (!keepVideo) {
        try { state.videoCodec = Demux.videoTrack(raw); } catch (e) { state.videoCodec = null; }
      }
      // Kept whole: the slice above belongs to this clip, the source to the file.
      if (!keepVideo) {
        srcCache = { file, buffer: state.srcBuffer, srcAudio: state.srcAudio,
                     videoCodec: state.videoCodec, video: state.video,
                     decodable: state.videoDecodable };
      }
    }
    // A split piece has its own name; the File it shares says nothing useful.
    if (!keepVideo) state.name = (restore && restore.name) || file.name.replace(/\.[^.]+$/, '');
    state.file = file;      // kept so the voice track can ship with an export

    // Mixing down and normalising is one pass per sample per channel — tens of
    // millions of iterations on a long clip. Done in one go it freezes the
    // page; in slices it lets the badge and the progress bar keep up.
    working(true, 'Preparing the audio…');
    const n = audio.length;
    const mono = new Float32Array(n);
    const SLICE = 1 << 21;
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i += SLICE) {
        const end = Math.min(n, i + SLICE);
        for (let k = i; k < end; k++) mono[k] += d[k];
        if (n > SLICE) await new Promise(r => setTimeout(r, 0));
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i += SLICE) {
      const end = Math.min(n, i + SLICE);
      for (let k = i; k < end; k++) {
        mono[k] /= audio.numberOfChannels;
        const a = Math.abs(mono[k]);
        if (a > peak) peak = a;
      }
      if (n > SLICE) await new Promise(r => setTimeout(r, 0));
    }
    // normalise, so the gate means one thing whatever the recording level
    if (peak > 0.02) {
      for (let i = 0; i < n; i += SLICE) {
        const end = Math.min(n, i + SLICE);
        for (let k = i; k < end; k++) mono[k] /= peak;
        if (n > SLICE) await new Promise(r => setTimeout(r, 0));
      }
    }
    state.mono = mono;

    $('drop').style.display = 'none';
    setLoadedUI(true);
    $('fileName').textContent = keepVideo ? state.name + ' + ' + file.name : file.name;
    const vc = state.videoCodec;
    $('fileMeta').textContent = state.video
      ? fmtTime(audio.duration) + ' · ' + state.video.w + '×' + state.video.h +
        (vc ? ' · ' + vc.name : '')
      : fmtTime(audio.duration) + ' · ' + Math.round(audio.sampleRate).toLocaleString() + ' Hz · ' +
        (audio.numberOfChannels === 1 ? 'mono' : audio.numberOfChannels + ' ch');

    updateCodecNote();
    overlayToolsVisible(placeable());
    $('videoWarn').hidden = !(state.video && !puppet.kind && !state.videoDecodable);
    if (state.video && !puppet.kind && !state.videoDecodable) {
      toast('The audio is fine, but no video frames reached the page' +
            (state.videoCodec ? ' — this clip is ' + state.videoCodec.name + '. Convert it to H.264.'
                              : '. Converting it to H.264 usually fixes this.'), 9000);
    }
    $('tTotal').textContent = fmtTime(state.buffer.duration);
    refreshDiagnostics();
    transportEnabled(true);
    // Park the element at the trim's in point. Without this a trimmed clip
    // starts playing from the head of the FILE, which is silence or somebody
    // else's line, while the readout insists it is at zero.
    seekTo(0);
    trimBarVisible(true);
    trimReadout();
    drawTrim();
    setLooping(looping);     // the element is new; the choice is not

    if (restore) {
      restore.duration = audio.duration;
      restore.video = state.video;
      /* A long clip is a long JOB, not a broken one.

         This used to set `error = 'too long'`, and a batch skips anything with
         an error — so a queue with one long line in it quietly exported three
         of four and said so afterwards, in a status line, in grey. The user
         had chosen "All 4 clips" and pressed Export; the answer to that is the
         four clips, or a reason given BEFORE the run rather than a note after
         it.

         So length is advisory now. The clip is marked `long`, the batch card
         says what the run will cost before it starts, and the thing that
         actually protects a run from going wrong — BATCH_MAX_BYTES, measured
         as the zip is built — does the protecting. An `error` is reserved for
         a clip that could not be READ, which is the only kind a batch has no
         way to export. */
      restore.error = null;
      applyClipSettings(restore);
    }

    // A clip coming back into view keeps the frames and the hand edits it left
    // with; only a clip that has never been analysed pays for the analysis.
    if (restore && restore.frames.length) {
      state.frames = restore.frames;
      state.script = restore.script || [];
      state.dirty = restore.dirty;
      state.fps = parseInt($('fps').value, 10);
      state.sel = state.selEnd = 0;
      $('frameCount').textContent = state.frames.length.toLocaleString() +
        ' frames · ' + state.fps + ' fps';
      resetHistory();
      updateSelReadout();
      setExportsEnabled(true);
      layoutSheet(); drawSheet(); drawOverview(); drawStage(); updateEstimates();
    } else {
      // Clear the outgoing clip's frames and edited flag FIRST. runAnalysis
      // preserves hand edits by reading state.dirty and state.frames, so
      // leaving the previous clip's there paints its edits onto this one.
      if (restore) { state.frames = []; state.dirty = false; state.script = []; }
      await runAnalysis();
      if (restore) { restore.frames = state.frames; restore.analysed = state.frames.length > 0; }
    }
    renderQueue();
  } catch (e) {
    console.error(e);
    if (restore) restore.error = 'unreadable';
    renderQueue();
    toast('Could not read ' + file.name + ': ' + ((e && e.message) || e) +
          '. WAV, MP3, M4A, OGG, MP4 and MOV are the safe bets.', 7000);
  } finally {
    working(false);
  }
}

function clearAudio() {
  stopPlayback();
  // The element is about to lose its source, so the kept decode of it goes too.
  forgetSrcCache();
  if (playerURL) { URL.revokeObjectURL(playerURL); playerURL = null; }
  player.removeAttribute('src');
  player.load();
  state.buffer = null; state.srcBuffer = null; state.mono = null; state.file = null; state.frames = []; state.sel = 0; state.selEnd = 0;
  state.video = null; state.needsAudio = false; state.srcAudio = null; state.videoDecodable = true; state.videoCodec = null;
  const gone = activeClip();
  if (gone) { gone.puppet = null; gone.layers = null; gone.cast = null; }
  dropPuppet(true);
  /* The puppet went and the lips stayed — reported as exactly that. The mouth
     is a LAYER now, and nothing was clearing the stack, so the compositor went
     on drawing a resting mouth over an empty stage (and any backdrop that had
     been put behind it) after the voice it belonged to was gone.

     The audio is the clip. Take it away and what was built on it goes too —
     except the canvas, which is a format rather than a thing on the stage and
     is kept on purpose. */
  layers = [];
  selectedLayerId = null;
  layerEditorId = null;
  parkMotionRows();
  Object.assign(overlay, { x: 0.5, y: 0.66, size: 0.30, rot: 0 });
  Object.assign(puppetPose, PUPPET_POSE);
  Object.assign(mirror, { lips: false, plate: false });
  renderLayerPanel();
  syncLayerSelect();
  overlayToolsVisible(false);
  sizeStage();
  $('drop').style.display = '';
  setLoadedUI(false);
  updateCodecNote();     // the note was about the clip that just left
  transportEnabled(false);
  trimBarVisible(false);
  $('tTotal').textContent = '0:00.00';
  $('tNow').textContent = '0:00.00';
  $('frameCount').textContent = '— frames';
  $('badgeFrame').textContent = '—';
  $('badgeViseme').textContent = '—';
  setExportsEnabled(false);
  drawStage(); drawSheet(); drawOverview(); updateEstimates();
}

/* ---------------------------------------------------------------- analysis */

let analysisToken = 0;
async function runAnalysis() {
  if (!state.mono) return;
  const token = ++analysisToken;
  const fps = state.fps = parseInt($('fps').value, 10);
  const keep = state.dirty ? state.frames.map(f => f.edited ? f.v : null) : null;
  const eng = ENGINES[engine];

  $('progress').classList.add('on');
  $('progressBar').style.width = '0%';
  setAnalysing(true, eng === ENGINES.rhubarb ? 'Loading Rhubarb…' : 'Analysing…');

  const onProgress = p => { if (token === analysisToken) $('progressBar').style.width = (p * 100).toFixed(0) + '%'; };
  const onStatus = m => { if (token === analysisToken) setAnalysing(true, m); };

  try {
    const frames = await eng.run(state.mono, state.buffer.sampleRate, fps, { ...cfg }, onProgress, onStatus);
    if (token !== analysisToken) return;
    state.frames = frames;
    if (keep) {
      for (let i = 0; i < state.frames.length && i < keep.length; i++) {
        if (keep[i]) { state.frames[i].v = keep[i]; state.frames[i].edited = true; }
      }
    }
    $('frameCount').textContent = state.frames.length.toLocaleString() + ' frames · ' + fps + ' fps';
    state.sel = Math.min(state.sel, state.frames.length - 1);
    state.selEnd = Math.min(state.selEnd, state.frames.length - 1);
    resetHistory();
    updateSelReadout();
    setExportsEnabled(true);
    // The offer of a puppet only makes sense once there is a take to put one
    // behind, so it waits until here.
    syncPuppetUI();
    layoutSheet(); drawSheet(); drawOverview(); drawStage(); updateEstimates();
  } catch (e) {
    if (token !== analysisToken) return;
    console.error(e);
    toast(engine === 'rhubarb'
      ? 'Rhubarb could not run: ' + (e.message || e) + ' — switching back to the built-in engine.'
      : 'Analysis failed: ' + (e.message || e), 5200);
    if (engine === 'rhubarb') { engine = 'dsp'; $('engineSel').value = 'dsp'; syncEngineUI(); runAnalysis(); return; }
  } finally {
    if (token === analysisToken) {
      $('progress').classList.remove('on');
      $('progressBar').style.width = '0%';
      setAnalysing(false);
    }
  }
}

/** The badge that says something is happening. Kept separate from the progress
    bar because the bar animates width, which stops dead the moment script
    blocks; the badge's spinner is a transform and keeps turning regardless. */
function working(on, msg) {
  const el = $('working');
  if (!el) return;
  if (msg) $('workingMsg').textContent = msg;
  el.hidden = false;
  el.classList.toggle('on', !!on);
  clearTimeout(working._t);
  if (!on) working._t = setTimeout(() => { el.hidden = true; }, 250);
}

/** Give the browser a chance to actually paint before blocking it. Two frames:
    one to run the style change, one to be sure it reached the screen. */
const paintNow = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

function setAnalysing(on, msg) {
  const chip = $('engineChip');
  chip.classList.toggle('busy', !!on);
  $('engineTxt').textContent = on && msg ? msg : 'Engine · ' + ENGINES[engine].label;
  document.body.classList.toggle('busy', !!on);
  working(!!on, msg || 'Working…');
}

function syncEngineUI() {
  const isDsp = engine === 'dsp';
  ['vs', 'detectL'].forEach(id => {
    const el = $(id);
    el.disabled = !isDsp;
    const field = el.closest('.field') || el.closest('.check');
    if (field) field.style.opacity = isDsp ? '' : '.45';
  });
  $('engineNote').textContent = ENGINES[engine].note;
  setAnalysing(false);
}

/* -------------------------------------------------------------- stage paint */

function currentFrameIndex() {
  if (!state.frames.length) return 0;
  if (playing || playTime() > 0) return clamp(Math.floor(playTime() * state.fps), 0, state.frames.length - 1);
  return selRange()[0];
}

/* ---- the demo -----------------------------------------------------------------

   Five seconds of speech and a drawn face, so that opening the file for the
   first time shows the thing working rather than an empty stage and four tabs
   of settings for something that is not there. It is also the way back: load
   your own clip, make a mess of the timing, and the button puts a known-good
   state on the screen to compare against.

   The voice is synthesized rather than recorded — eSpeak NG, a free formant
   synthesiser — for two reasons. A recording of a person is a person's voice
   to host and to ship, and this file goes in a public repository; and a
   synthesiser gives clean, evenly spaced phonemes, which is exactly what makes
   the exposure sheet legible as an example. It sounds like a robot. It is
   meant to: the point of the demo is the mouth, not the acting.

   Carried as base64 rather than fetched, like everything else in this file.
--------------------------------------------------------------------------- */
const DEMO_NAME = 'demo-voice.mp3';
const DEMO_FACE = 'woman';
const DEMO_MP3 = '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qqqqqkxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/zYsRvAAADSAAAAACqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/82LEbwAAA0gAAAAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//NixG8AAANIAAAAAKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqTEFNRTMuMTAwqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/zYMRwAAADSAAAAACqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqv/zYsRvAAADSAAAAACqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpMQU1FMy4xMDCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr/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';

function demoFile() {
  const bin = atob(DEMO_MP3);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], DEMO_NAME, { type: 'audio/mpeg' });
}

/** True while what is loaded IS the demo and nothing else — which is what
    decides whether the button says "Demo" or "Restore demo". */
function demoIsLoaded() {
  return queue.clips.length === 1 && queue.clips[0].file &&
         queue.clips[0].file.name === DEMO_NAME;
}

function syncDemoBtn() {
  const b = $('demoBtn');
  if (!b) return;
  const own = queue.clips.length > 0 && !demoIsLoaded();
  b.textContent = own ? 'Restore demo' : 'Demo';
  b.title = own
    ? 'Clear what is loaded and put the demo clip and face back'
    : 'A short recorded line and a drawn face, so there is something to look at';
}

let demoBusy = false;
async function loadDemo() {
  if (demoBusy) return;
  demoBusy = true;
  const b = $('demoBtn');
  if (b) b.disabled = true;
  try {
    // Everything out first. Restoring the demo on top of a queue would leave
    // the user's clips in it, which is not what the word restore means.
    if (queue.clips.length) clearQueue();
    await addFiles([demoFile()]);
    await useFace(DEMO_FACE, true);
    toast('Demo loaded — press space to play it.', 3400);
  } finally {
    demoBusy = false;
    if (b) b.disabled = false;
    syncDemoBtn();
  }
}

/* ---- four drawn faces to try the lips on -------------------------------------

   A puppet is normally something you bring: a photograph of a minifigure, a
   drawing, a frame of video. That leaves a first-time visitor with a mouth
   floating on a checkerboard and no idea what the thing is for, and it leaves
   anyone testing a style with nothing to test it against.

   So there are four here — a man, a woman, a child and an older person — drawn
   in the page rather than carried as pictures. They are deliberately plain:
   flat colour, one weight of line, no mouth. The mouth is the app's job, and a
   face that already had one would be answering the question it is asking.

   Each one knows where its mouth belongs, so choosing a face places the lips
   as well as the picture. Drawn at 900x1200 — big enough that an export at
   2048 is not resampling upward, small enough that four of them are not a
   memory problem.
--------------------------------------------------------------------------- */
const FACE_W = 900, FACE_H = 1200;

const FACES = {
  man: {
    label: 'Man',
    style: 'faceman',
    skin: '#F0C9A4', shade: '#DDAE85', hair: '#4A342A', hairDark: '#39271F',
    shirt: '#5C7FA8',
    // where the mouth goes, in the frame's own fractions
    place: { x: 0.500, y: 0.545, size: 0.215 }
  },
  woman: {
    label: 'Woman',
    style: 'facewoman',
    skin: '#F3CFAE', shade: '#E0B18E', hair: '#8A4B2A', hairDark: '#6E3920',
    shirt: '#B4697A',
    place: { x: 0.500, y: 0.548, size: 0.195 }
  },
  child: {
    label: 'Child',
    style: 'facechild',
    skin: '#F6D3B4', shade: '#E8B894', hair: '#C9893F', hairDark: '#A96D2C',
    shirt: '#59A98B',
    place: { x: 0.500, y: 0.566, size: 0.190 }
  },
  older: {
    label: 'Older',
    style: 'faceolder',
    skin: '#EBCBB2', shade: '#D6AE93', hair: '#CFCBC4', hairDark: '#AFAAA2',
    shirt: '#7D7E86',
    place: { x: 0.500, y: 0.552, size: 0.200 }
  }
};

const FACE_INK = '#2B2724';

/** A drawn face as a File, so it travels the same road as a photograph: the
    same decode, the same placement, the same record on the clip, the same copy
    shipped to Final Cut. Nothing downstream needs to know it was drawn. */
function faceFile(kind) {
  const c = document.createElement('canvas');
  c.width = FACE_W; c.height = FACE_H;
  const x = c.getContext('2d');
  // Transparent, not white. A face on white would print a white rectangle over
  // whatever it was composited onto, and the transparent exports are half the
  // reason anyone is here.
  drawFace(x, FACE_W, FACE_H, kind);
  return new Promise(res => c.toBlob(
    b => res(new File([b], 'face-' + kind + '.png', { type: 'image/png' })), 'image/png'));
}

/** Choose a drawn face: the picture, where its mouth goes, and the lip style
    drawn for it.

    All three ON THE FIRST VISIT ONLY. That was the whole behaviour once, and
    it is right exactly once: the second time, "the lip style drawn for this
    face" is a face overwriting the Squiggly set, the 22% mouth and the four
    keyframes you had just spent ten minutes on. A head is a head. Coming back
    to one restores what was last on it, and the pin refuses even the first
    suggestion. */
async function useFace(kind, quiet) {
  const F = FACES[kind];
  if (!F) return false;
  const e = castEntry('drawn:' + kind);
  const fresh = !e || !e.visited;
  const file = await faceFile(kind);
  // noCrop: it is drawn to its own frame, and the margin round it is the
  // composition rather than waste.
  const ok = await setPuppet(file, true, { noCrop: true });
  if (!ok) return false;
  if (!fresh) {
    castWear(e);
  } else if (!keepLips) {
    // F.place is written against the drawn face's own 900×1200 picture, so it
    // goes through the same move as any other authored placement.
    Object.assign(overlay, onPuppet({ ...F.place, rot: 0 }));
    const id = styleViewId(F.style, 'front');
    if (STYLES[id]) {
      state.style = id;
      custom.on = false; custom.map = {}; custom.sources = [];
      if (typeof lips !== 'undefined') { lips.activeId = null; }
      const c = activeClip();
      if (c) { c.style = id; c.lipSetId = null; }
    }
  }
  // Whatever route was taken, this head now wears what is on the stage.
  castRemember('drawn:' + kind, { faceKind: kind, label: F.label, kind: 'drawn' });
  castBankCurrent();
  PLATE_BOXES.forEach(({ id: bid, on }) => { const b = $(bid); if (b) b.checked = on; });
  buildStyleChips(); buildLipChips(); buildChart();
  renderQueue();
  syncPuppetUI();
  sizeStage();
  drawStage();
  updateEstimates();
  updateOverlayReadout();
  syncFacePick();
  if (!quiet) toast('Using the drawn ' + F.label.toLowerCase() + '.', 2400);
  return true;
}

/* ---- the cast ---------------------------------------------------------------

   The four drawn faces, and everything you have loaded this visit, in one row
   of chips. Choosing one switches to it; nothing is thrown away by switching.

   That last part is the whole point. Before it, "Replace…" meant replace: load
   the second drawing and the first was gone, and getting it back meant finding
   the file again and placing the mouth again. The common job — the same line
   tried on three characters — was the one the app was worst at.

   A chip is not a picture. It is a CHARACTER, and a character is six things
   that have to travel together or none of them is any use:

       picture        the file, and the crop it arrived with
       pose           where that picture sits in the frame
       mouth          where the mouth sits on it, how big, and its keyframes
       lips           which style or imported set it speaks with
       mirror         whether it is facing the other way

   Keeping only the first three — which is what this was — meant switching
   heads threw away the lips and the keys every time, and the drawn faces threw
   them away twice over by insisting on their own. Six fields in one record
   fixes that, and the same record is what a clip points at when a split
   conversation gives each line a speaker.

   Session-only and in memory, like everything else here: the files are not
   written anywhere, and closing the tab clears the cast.
--------------------------------------------------------------------------- */
const puppetShelf = [];

/** Off by default, because a face the app drew knows better than the default
    mouth where its own mouth goes, and refusing that help on the first visit
    makes the drawn faces pointless. On, nothing is ever suggested. */
let keepLips = false;

const castEntry = id => puppetShelf.find(e => e.id === id) || null;

/** Make sure a chip exists, and return it. */
function castRemember(id, extra) {
  let e = castEntry(id);
  if (!e) { e = { id }; puppetShelf.push(e); }
  Object.assign(e, extra || {});
  return e;
}

/** Everything live, onto a chip. `visited` is what separates "this head has
    never been worn, so suggest something" from "this is how you left it". */
function castBankTo(e) {
  if (!e) return;
  e.pose = { ...puppetPose };
  e.mouth = { x: overlay.x, y: overlay.y, size: overlay.size, rot: overlay.rot };
  e.lips = { style: state.style, lipSetId: (typeof lips !== 'undefined' ? lips.activeId : null) };
  e.mirror = { ...mirror };
  e.visited = true;
}

/** And back the other way. The picture is already on the stage by the time
    this runs — only the five things ABOUT it are put back here. */
function castWear(e) {
  if (!e) return;
  Object.assign(puppetPose, PUPPET_POSE, e.pose || {});
  if (e.mouth) {
    Object.assign(overlay, {
      x: e.mouth.x, y: e.mouth.y, size: e.mouth.size, rot: e.mouth.rot || 0
    });
  }
  Object.assign(mirror, { lips: false, plate: false }, e.mirror || {});
  const c = activeClip();
  if (e.lips) {
    if (e.lips.lipSetId && typeof lipSetById === 'function' && lipSetById(e.lips.lipSetId)) {
      useLipSet(e.lips.lipSetId);
    } else if (e.lips.style && STYLES[e.lips.style]) {
      state.style = e.lips.style;
      custom.on = false; custom.map = {}; custom.sources = [];
      if (typeof lips !== 'undefined') lips.activeId = null;
      buildStyleChips(); buildLipChips();
    }
    if (c) { c.style = state.style; c.lipSetId = (typeof lips !== 'undefined' ? lips.activeId : null); }
  }
  if (c) { c.puppetPose = { ...puppetPose }; c.mirror = { ...mirror }; }
}

const FACE_FILE_RE = /^face-([a-z]+)\.png$/;

/** Which face, if any, is on the stage — by the file name it was given, which
    is the only thing that survives being banked on a clip and read back. */
function activeFaceKind() {
  const m = FACE_FILE_RE.exec(puppet.name || '');
  return m && FACES[m[1]] ? m[1] : null;
}

/** A stable id for a loaded file. Name and size together, because two files
    called photo.png from different folders are two puppets, and the same file
    chosen twice is one. */
const shelfIdFor = f => 'f:' + f.name + ':' + (f.size || 0);

function activeShelfId() {
  const k = activeFaceKind();
  if (k) return 'drawn:' + k;
  const c = activeClip();
  const f = c && c.puppet && c.puppet.file;
  return f ? shelfIdFor(f) : null;
}
function activeShelfEntry() {
  const id = activeShelfId();
  return id ? puppetShelf.find(e => e.id === id) || null : null;
}

/** A chip-sized picture of a loaded puppet, letterboxed into the tile. Taken
    once, when the puppet arrives, because a chip that re-reads the file every
    repaint is a decode per chip per keystroke. */
function shelfThumb(src, w, h) {
  const S = 3, cw = 30 * S, ch = 34 * S;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  if (!w || !h) return c.toDataURL('image/png');
  const k = Math.min(cw / w, ch / h);
  const dw = w * k, dh = h * k;
  try { x.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh); } catch (e) {}
  return c.toDataURL('image/png');
}

/** Say on the record which cast member the open clip is wearing.

    `bankClip` does this too, but only when you switch away — so the queue row
    kept the previous face until you clicked another line, and the cast bar
    could not tell which chip was in use. The head and the record agree from
    the moment the head changes. */
function markClipCast() {
  const c = activeClip();
  if (!c) return null;
  c.cast = activeShelfId();
  return c.cast;
}

/** Put everything live back on the chip that is showing, before leaving it. */
function shelfBankCurrent() { castBankTo(activeShelfEntry()); }
const castBankCurrent = shelfBankCurrent;

/** Record a puppet that has just been loaded, or find the record it already
    has. Drawn faces are on the shelf from the start and never duplicated. */
function shelfRemember(file, extra) {
  if (FACE_FILE_RE.test(file.name)) return null;
  const id = shelfIdFor(file);
  let e = puppetShelf.find(x => x.id === id);
  if (!e) {
    e = { id, kind: 'file', label: file.name.replace(/\.[^.]+$/, ''), file };
    puppetShelf.push(e);
  }
  e.file = file;
  Object.assign(e, extra || {});
  return e;
}

/** Switch to a chip. */
async function useShelf(id) {
  const e = puppetShelf.find(x => x.id === id);
  if (!e) return false;
  if (id === activeShelfId()) { markClipCast(); return true; }
  shelfBankCurrent();
  if (e.kind === 'drawn') {
    const got = await useFace(e.faceKind);
    if (got) { markClipCast(); renderQueue(); }
    return got;
  }

  const ok = await setPuppet(e.file, true,
                             { noCrop: true, uncropped: e.uncropped, cropBox: e.cropBox });
  if (!ok) return false;
  markClipCast();
  // A photograph has no lips of its own to suggest, so there is nothing to
  // decide here: either this head has been worn before and gets its own back,
  // or it keeps whatever is live. Both are "do not lose the user's work".
  if (e.visited) castWear(e);
  castBankCurrent();
  buildStyleChips(); buildLipChips(); buildChart();
  renderQueue();
  syncPlateTransform();
  syncPuppetUI();
  sizeStage();
  drawStage();
  updateOverlayReadout();
  updateEstimates();
  buildPuppetShelf();
  toast('Using “' + e.label + '”.', 2000);
  return true;
}

/** Take a loaded puppet out of the cast for good.

    Removing the PICTURE was never the whole job, which is why "Remove" looked
    broken: it cleared the stage and left the chip sitting in the row, so a
    background imported by mistake was one click from being back. The chip is
    the thing that has to go. */
function dropFromCast(id) {
  const i = puppetShelf.findIndex(e => e.id === id);
  if (i < 0) return;
  const e = puppetShelf[i];
  const wasOn = activeShelfId() === id;
  puppetShelf.splice(i, 1);
  // Any clip pointing at it loses its puppet too, or the queue would hand it
  // back the moment you clicked another line.
  queue.clips.forEach(c => {
    if (c.puppet && c.puppet.file && shelfIdFor(c.puppet.file) === id) c.puppet = null;
    if (c.cast === id) c.cast = null;
  });
  if (wasOn) forgetPuppet();
  buildPuppetShelf();
  renderQueue();
  renderLayerPanel();
  syncPuppetUI();
  drawStage();
  toast('“' + (e.label || 'that one') + '” is out of the cast.', 2600);
}

function syncFacePick() {
  const on = activeShelfId();
  document.querySelectorAll('.facepick button[data-shelf]').forEach(
    b => b.setAttribute('aria-pressed', String(b.dataset.shelf === on)));
}

/** The chips, rebuilt whenever the shelf changes. Each is the puppet itself at
    chip size rather than a word: four names in a row read as a form, four
    pictures read as a choice, and the picture is the thing being chosen. */
function buildPuppetShelf() {
  if (!puppetShelf.length) {
    Object.keys(FACES).forEach(kind => puppetShelf.push({
      id: 'drawn:' + kind, kind: 'drawn', faceKind: kind, label: FACES[kind].label
    }));
  }
  document.querySelectorAll('.facepick').forEach(wrap => {
    wrap.innerHTML = '';
    puppetShelf.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.shelf = e.id;
      b.title = e.kind === 'drawn'
        ? 'Put the drawn ' + e.label.toLowerCase() + ' behind the mouth'
        : 'Switch back to ' + e.label;
      b.setAttribute('aria-label', b.title);
      b.setAttribute('aria-pressed', 'false');
      if (e.kind === 'drawn') {
        const c = document.createElement('canvas');
        const S = 3;                                  // retina-ish for a 30px chip
        c.width = 30 * S; c.height = 34 * S;
        const x = c.getContext('2d');
        // Just the head: the shoulders are most of the drawing at this size and
        // none of the recognition.
        x.scale(c.width / (FACE_W * 0.78), c.width / (FACE_W * 0.78));
        x.translate(-FACE_W * 0.11, -FACE_H * 0.055);
        drawFace(x, FACE_W, FACE_H, e.faceKind);
        b.appendChild(c);
      } else {
        const i = document.createElement('img');
        i.src = e.thumb || '';
        i.alt = '';
        b.appendChild(i);
      }
      b.onclick = () => useShelf(e.id);
      // The four drawn faces are the app's own and have no × — they are the
      // offer, not something you loaded, and a row you can empty by accident
      // with nothing to put back in it is worse than a row with four chips in
      // it. Everything you loaded yourself can go.
      if (e.kind === 'drawn') { wrap.appendChild(b); return; }
      const cell = document.createElement('span');
      cell.className = 'chipwrap';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chipx';
      x.textContent = '×';
      x.title = 'Take “' + e.label + '” out of the cast';
      x.setAttribute('aria-label', x.title);
      x.onclick = ev => { ev.stopPropagation(); dropFromCast(e.id); };
      cell.append(b, x);
      wrap.appendChild(cell);
    });
    // The pin, at the end of the row it governs. Built here rather than put in
    // the markup because there are two of these rows and one of them is in a
    // panel that comes and goes — two copies in the HTML is two copies to keep
    // in step, and this one has a state to show.
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'lippin';
    pin.dataset.pin = '1';
    pin.setAttribute('aria-pressed', String(keepLips));
    pin.title = keepLips
      ? 'Lips are pinned — changing heads will not touch the style, size or keys'
      : 'Pin the lips, so a drawn face stops bringing its own';
    pin.setAttribute('aria-label', pin.title);
    pin.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l2.5 3.2h-11z"/></svg>';
    pin.onclick = () => {
      keepLips = !keepLips;
      buildPuppetShelf();
      toast(keepLips
        ? 'Lips pinned. Changing heads keeps the style, the size and the keyframes.'
        : 'Lips unpinned. A drawn face may bring its own again — the first time only.', 3600);
    };
    wrap.appendChild(pin);
  });
  syncFacePick();
}

/** Kept under its old name because boot calls it. */
function buildFacePick() { buildPuppetShelf(); }

/** The head, the hair, the eyes and the shoulders — everything but the mouth.
    One construction with four sets of numbers, so the four read as a family
    and a change to the drawing reaches all of them. */
function drawFace(ctx, W, H, kind) {
  const F = FACES[kind] || FACES.man;
  const lw = W * 0.0105;
  const cx = W * 0.5;
  // Proportions by age: a child's head is bigger against its body and its
  // features sit lower on it, an older face is longer. This is most of what
  // tells the four apart before any hair is drawn.
  const prop = {
    man:   { hy: 0.400, hrx: 0.300, hry: 0.270, eye: 0.385, ew: 0.112, er: 0.0295, sh: 0.760, shw: 0.400 },
    woman: { hy: 0.398, hrx: 0.282, hry: 0.268, eye: 0.382, ew: 0.106, er: 0.0300, sh: 0.762, shw: 0.360 },
    child: { hy: 0.412, hrx: 0.306, hry: 0.272, eye: 0.405, ew: 0.112, er: 0.0330, sh: 0.790, shw: 0.330 },
    older: { hy: 0.396, hrx: 0.288, hry: 0.280, eye: 0.378, ew: 0.110, er: 0.0280, sh: 0.756, shw: 0.385 }
  }[kind] || {};
  const hy = H * prop.hy, hrx = W * prop.hrx, hry = H * prop.hry;

  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = FACE_INK;
  ctx.lineWidth = lw;

  // --- shoulders, behind the head ------------------------------------------
  const sy = H * prop.sh;
  ctx.beginPath();
  ctx.moveTo(cx - W * prop.shw, H + lw);
  ctx.quadraticCurveTo(cx - W * prop.shw * 0.92, sy, cx, sy - H * 0.012);
  ctx.quadraticCurveTo(cx + W * prop.shw * 0.92, sy, cx + W * prop.shw, H + lw);
  ctx.closePath();
  ctx.fillStyle = F.shirt; ctx.fill(); ctx.stroke();

  // --- neck -----------------------------------------------------------------
  ctx.beginPath();
  const nw = W * 0.082;
  ctx.moveTo(cx - nw, hy + hry * 0.62);
  ctx.lineTo(cx - nw, sy + H * 0.012);
  ctx.lineTo(cx + nw, sy + H * 0.012);
  ctx.lineTo(cx + nw, hy + hry * 0.62);
  ctx.closePath();
  ctx.fillStyle = F.shade; ctx.fill(); ctx.stroke();

  // --- ears -----------------------------------------------------------------
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * hrx * 0.98, hy + hry * 0.08, W * 0.034, H * 0.042, 0, 0, Math.PI * 2);
    ctx.fillStyle = F.skin; ctx.fill(); ctx.stroke();
  }

  // --- head -----------------------------------------------------------------
  ctx.beginPath();
  ctx.ellipse(cx, hy, hrx, hry, 0, 0, Math.PI * 2);
  ctx.fillStyle = F.skin; ctx.fill(); ctx.stroke();

  // --- hair -----------------------------------------------------------------
  ctx.save();
  ctx.fillStyle = F.hair;
  ctx.strokeStyle = FACE_INK;
  if (kind === 'woman') {
    // Long, falling past the jaw on both sides, drawn behind nothing — the
    // face is on top of it, which is why it is filled as one shape.
    ctx.beginPath();
    ctx.moveTo(cx - hrx * 1.12, hy + hry * 1.02);
    // A cubic, not a quadratic. One control point above the crown pulls the
    // two sides into a peak and the result is a witch's hat; two, set wide,
    // give the round head of hair that was wanted.
    ctx.bezierCurveTo(cx - hrx * 1.26, hy - hry * 0.96, cx - hrx * 0.62, hy - hry * 1.30,
                      cx, hy - hry * 1.30);
    ctx.bezierCurveTo(cx + hrx * 0.62, hy - hry * 1.30, cx + hrx * 1.26, hy - hry * 0.96,
                      cx + hrx * 1.12, hy + hry * 1.02);
    ctx.quadraticCurveTo(cx + hrx * 0.96, hy + hry * 0.44, cx + hrx * 0.98, hy - hry * 0.10);
    ctx.quadraticCurveTo(cx + hrx * 0.30, hy - hry * 0.62, cx - hrx * 0.34, hy - hry * 0.52);
    ctx.quadraticCurveTo(cx - hrx * 0.98, hy - hry * 0.26, cx - hrx * 0.98, hy + hry * 0.44);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (kind === 'child') {
    // A round cap with a tuft, which is the shorthand for "young" that every
    // drawn set in the references uses.
    ctx.beginPath();
    ctx.moveTo(cx - hrx * 1.01, hy - hry * 0.04);
    ctx.bezierCurveTo(cx - hrx * 1.10, hy - hry * 0.92, cx - hrx * 0.60, hy - hry * 1.22,
                      cx, hy - hry * 1.22);
    ctx.bezierCurveTo(cx + hrx * 0.60, hy - hry * 1.22, cx + hrx * 1.10, hy - hry * 0.92,
                      cx + hrx * 1.01, hy - hry * 0.04);
    ctx.quadraticCurveTo(cx + hrx * 0.62, hy - hry * 0.50, cx + hrx * 0.10, hy - hry * 0.46);
    ctx.quadraticCurveTo(cx - hrx * 0.58, hy - hry * 0.42, cx - hrx * 1.01, hy - hry * 0.04);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // A sprig that curls back on itself. Drawn as a single sharp spike it came
    // out as a horn, which is a different character altogether.
    ctx.beginPath();
    ctx.moveTo(cx + hrx * 0.04, hy - hry * 1.06);
    ctx.bezierCurveTo(cx + hrx * 0.20, hy - hry * 1.42, cx + hrx * 0.52, hy - hry * 1.36,
                      cx + hrx * 0.50, hy - hry * 1.14);
    ctx.bezierCurveTo(cx + hrx * 0.44, hy - hry * 1.28, cx + hrx * 0.22, hy - hry * 1.22,
                      cx + hrx * 0.30, hy - hry * 1.02);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (kind === 'older') {
    // Receded at the temples and thin on top — drawn as two shapes with the
    // forehead showing between them, because a single cap just reads as a
    // lighter hair colour.
    ctx.beginPath();
    ctx.moveTo(cx - hrx * 1.02, hy + hry * 0.14);
    ctx.quadraticCurveTo(cx - hrx * 1.06, hy - hry * 0.86, cx - hrx * 0.30, hy - hry * 0.94);
    ctx.quadraticCurveTo(cx - hrx * 0.74, hy - hry * 0.56, cx - hrx * 0.86, hy + hry * 0.12);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + hrx * 1.02, hy + hry * 0.14);
    ctx.quadraticCurveTo(cx + hrx * 1.06, hy - hry * 0.86, cx + hrx * 0.30, hy - hry * 0.94);
    ctx.quadraticCurveTo(cx + hrx * 0.74, hy - hry * 0.56, cx + hrx * 0.86, hy + hry * 0.12);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else {
    // A side part, swept across. The man is the only one with a parting, which
    // is the cheapest way to make him not simply "the default head".
    ctx.beginPath();
    ctx.moveTo(cx - hrx * 1.02, hy - hry * 0.10);
    ctx.quadraticCurveTo(cx - hrx * 1.04, hy - hry * 1.14, cx + hrx * 0.10, hy - hry * 1.08);
    ctx.quadraticCurveTo(cx + hrx * 1.02, hy - hry * 1.00, cx + hrx * 1.00, hy - hry * 0.04);
    ctx.quadraticCurveTo(cx + hrx * 0.78, hy - hry * 0.52, cx + hrx * 0.18, hy - hry * 0.58);
    ctx.quadraticCurveTo(cx - hrx * 0.46, hy - hry * 0.64, cx - hrx * 0.70, hy - hry * 0.18);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();

  // --- eyes -----------------------------------------------------------------
  const ey = H * prop.eye, ex = W * prop.ew, er = W * prop.er;
  ctx.fillStyle = FACE_INK;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * ex, ey, er, er * (kind === 'child' ? 1.15 : 1.05), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Brows. Angled down toward the nose on the older face, which is the one
  // feature that says age faster than any amount of line work.
  ctx.strokeStyle = kind === 'older' ? F.hairDark : F.hairDark;
  ctx.lineWidth = lw * (kind === 'older' ? 1.5 : 1.25);
  for (const s of [-1, 1]) {
    const by = ey - H * (kind === 'child' ? 0.050 : 0.058);
    ctx.beginPath();
    ctx.moveTo(cx + s * (ex - er * 1.5), by + H * (kind === 'older' ? 0.012 : 0.006));
    ctx.quadraticCurveTo(cx + s * ex, by - H * 0.014, cx + s * (ex + er * 1.6),
                         by + H * (kind === 'older' ? -0.004 : 0.004));
    ctx.stroke();
  }

  // --- nose -----------------------------------------------------------------
  ctx.strokeStyle = F.shade;
  ctx.lineWidth = lw * 1.3;
  ctx.beginPath();
  const ny = H * (kind === 'child' ? 0.480 : 0.472);
  ctx.moveTo(cx - W * 0.005, ny - H * (kind === 'child' ? 0.028 : 0.042));
  ctx.quadraticCurveTo(cx + W * 0.030, ny, cx - W * 0.016, ny + H * 0.004);
  ctx.stroke();

  // --- age and character marks ---------------------------------------------
  ctx.strokeStyle = F.shade;
  ctx.lineWidth = lw * 0.95;
  if (kind === 'older') {
    // Two lines from the nose to the corners of where the mouth will be, and a
    // pair across the forehead. Nothing more: more than this and a cartoon
    // stops being old and starts being ill.
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * W * 0.050, H * 0.486);
      ctx.quadraticCurveTo(cx + s * W * 0.112, H * 0.530, cx + s * W * 0.108, H * 0.590);
      ctx.stroke();
    }
    for (let i = 0; i < 2; i++) {
      const y = hy - hry * (0.40 - i * 0.13);
      ctx.beginPath();
      ctx.moveTo(cx - hrx * 0.42, y);
      ctx.quadraticCurveTo(cx, y - H * 0.012, cx + hrx * 0.42, y);
      ctx.stroke();
    }
    // Glasses, which is the other half of the shorthand.
    ctx.strokeStyle = FACE_INK;
    ctx.lineWidth = lw * 1.1;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * ex, ey, er * 2.3, er * 2.0, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - ex + er * 2.3, ey);
    ctx.lineTo(cx + ex - er * 2.3, ey);
    ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + s * (ex + er * 2.3), ey - er * 0.3);
      ctx.lineTo(cx + s * hrx * 0.99, ey - er * 0.6);
      ctx.stroke();
    }
  } else if (kind === 'child') {
    // Freckles, one dot at a time, in a fixed pattern — a random scatter would
    // be different every time the face was drawn.
    ctx.fillStyle = F.shade;
    const spots = [[-0.17, 0.498], [-0.135, 0.512], [-0.205, 0.516],
                   [0.17, 0.498], [0.135, 0.512], [0.205, 0.516]];
    for (const [fx, fy] of spots) {
      ctx.beginPath();
      ctx.ellipse(cx + W * fx, H * fy, W * 0.008, W * 0.008, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // A cheek shadow, so the man and the woman are not simply flat ovals.
    ctx.fillStyle = F.shade;
    ctx.globalAlpha = 0.55;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + s * hrx * 0.60, H * 0.500, W * 0.052, H * 0.030, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ---- the puppet: the picture the mouth goes on -------------------------------

   Until now the only way to get a picture under the mouth was to load a VIDEO
   as the clip, so one file had to supply both the soundtrack and the backdrop.
   That ruled out the most obvious job there is: a voice recording and a
   photograph of the doll.

   So the backdrop is its own input now, and it belongs to the CLIP rather than
   to the app — banked and restored alongside its placement, its lips and its
   edits, so a queue of lines can have a different puppet on each. Everything
   downstream asks `hasPlate()` instead of `state.video`, which means a clip
   that IS a video keeps behaving exactly as it did: its own footage is simply
   the plate nobody had to go and choose.
--------------------------------------------------------------------------- */

const puppet = {
  kind: null,                  // 'image' | 'video' | null
  name: '', w: 0, h: 0, duration: 0, alpha: false,
  url: null, img: null
};

const plateVideo = document.getElementById('platePlayer');

const clipSeconds = () =>
  state.buffer ? state.buffer.duration : state.frames.length / (state.fps || 12);

function hasPlate() { return !!(puppet.kind || state.video); }

/** The "Put the puppet behind it" boxes, and what each is set to the moment a
    puppet is chosen. Every export that can carry the puppet has one, so the
    answer to "which formats take it?" is this list rather than a hunt through
    seven export functions.

    The sprite sheet is the one that starts off. It is the export whose whole
    point is loose parts for an engine to compose at runtime, and an engine
    that wanted the puppet baked in would not need a sprite sheet of mouths. */
const PLATE_BOXES = [
  { id: 'fcpPlate',    on: true  },
  { id: 'mp4Plate',    on: true  },
  { id: 'gifPlate',    on: true  },
  { id: 'apngPlate',   on: true  },
  { id: 'seqPlate',    on: true  },
  { id: 'spritePlate', on: false }
];

/** Is this export to carry the puppet? Both halves matter: the box can be
    ticked from a previous clip that had one. */
/** Is there anything to compose besides the mouth? A puppet, or any layer a
    person has added. The export boxes used to ask only about the puppet, which
    was the only other thing there was. */
function hasStack() {
  return hasPlate() || layers.some(L => L.kind !== 'mouth' && L.kind !== 'plate' && L.visible);
}

/** Is there anything on the stage worth pointing at?

    This is the question the stage handles and the placement strip should be
    asking, and for a long time they asked `hasPlate()` instead — "is there a
    puppet". A picture added as a LAYER is not a puppet, so a perfectly normal
    stack of a mouth and a drawing left the strip hidden and every handle
    inert: drawn, grabbable-looking, and wired to an early return.

    The mouth alone counts, as soon as there are frames to put it on: placing
    the mouth on nothing is still the thing this app does. */
function placeable() {
  return hasStack() || (state.frames.length > 0 && layers.some(L => L.kind === 'mouth'));
}

/** Is this export to carry everything else? Both halves matter: the box can be
    ticked from a previous clip that had a stack. */
function plateOn(id) { const b = $(id); return !!(b && b.checked && hasStack()); }
/** The effects box on an export card: the line boil and the drop shadows.
    Ticked by default — what is on the stage is what comes out — but a mouth
    cut onto footage that is being graded somewhere else is a real reason to
    want them left off, and so is a boil that reads as noise at small sizes. */
const FX_BOXES = ['mp4Fx', 'gifFx', 'apngFx', 'spriteFx', 'seqFx', 'ovFx'];
function fxOff(id) { const b = $(id); return !!(b && !b.checked); }
const fxOpt = id => ({ noFx: fxOff(id) });
function plateHasAlpha() { return !!(puppet.kind && puppet.alpha); }

/** Will anything opaque fill the frame?

    Not the same question as plateHasAlpha(), which asks whether there IS a
    puppet and whether it is cut out. With no puppet at all the answer to that
    is "no", and the frame was being given a solid ground on the strength of
    it — telling someone with a transparent drawing on the stack that their
    export would not be see-through, when it would. */
function frameIsOpaque() {
  if (puppet.kind) return !puppet.alpha;
  return !!state.video;
}

/** The file the plate was made from, for the one export that ships it rather
    than drawing it: Final Cut wants the puppet as a layer it can move, not
    baked into a few hundred stills. */
function plateFile() {
  const c = activeClip();
  if (c && c.puppet && c.puppet.file) return c.puppet.file;
  return state.video ? state.file : null;
}

/** An added puppet wins over the clip's own footage. It was chosen; the footage
    is merely what the file happened to contain. */
/* ---- the frame -------------------------------------------------------------

   The canvas used to be whatever the puppet was: a 900x1200 drawing made a
   900x1200 export, and a square one with nothing loaded. That is the right
   default and it is still the default — but it is a poor rule once there is a
   stack, because the picture is no longer one photograph. A caption needs room
   under the chin; a 16:9 delivery needs 16:9 whatever shape the character is.

   Placements are fractions of the frame, so changing it REFLOWS: a layer in the
   middle stays in the middle, one at 20% across stays at 20% across. That is
   the behaviour that keeps a composition recognisable through a resize, and the
   alternative — holding pixel positions and cropping — pushes work off the edge
   where you cannot see it to drag it back.
--------------------------------------------------------------------------- */
const CANVAS_PRESETS = [
  ['auto',      'Match the puppet'],
  ['fit',       'Fit everything in the stack'],
  ['1920x1080', '1920 × 1080 · 16:9'],
  ['1280x720',  '1280 × 720 · 16:9'],
  ['1080x1920', '1080 × 1920 · vertical'],
  ['1080x1080', '1080 × 1080 · square'],
  ['custom',    'Custom…']
];
const canvasSetting = { mode: 'auto', w: 1920, h: 1080 };

/* The last frame the user CHOSE, as opposed to the one a clip happens to be
   carrying. A clip that has never had a canvas set on it takes this rather
   than falling back to "match the puppet" — set 1920×1080 once, cut the take
   into eight, and all eight are 16:9. Written only from the controls, so
   nothing the code does to the canvas on its own gets mistaken for a choice. */
let canvasPreference = null;

/** The output frame: what every export is built at and what the stage shows. */
function frameSize() {
  if (canvasSetting.mode === 'auto') {
    const pz = plateSize();
    return pz ? { w: pz.w, h: pz.h } : { w: 1024, h: 1024 };
  }
  return { w: Math.max(16, Math.round(canvasSetting.w)),
           h: Math.max(16, Math.round(canvasSetting.h)) };
}

/** Is there any picture at all to show — a puppet, or a layer someone added? */
function frameHasContent() { return hasPlate() || hasStack(); }

/* ---- a puppet arrives at the size of the frame it lands on ---------------

   A puppet's `size` is its width as a fraction of the frame, so 1 means "as
   wide as the frame". That was the right default for as long as the frame WAS
   the puppet — match-the-puppet is the default canvas — and it is badly wrong
   the moment the canvas is set to something else: a 900×1200 portrait dropped
   on a 1920×1080 frame at size 1 is 1920 wide and 2560 tall, which is a chin
   filling the screen and the stage reporting "1 layer off the edge".

   Reported after setting 1920×1080 and then cutting a take up: every puppet
   assigned afterwards "comes in large". So a new puppet is measured against
   the frame first. The arithmetic gives exactly 1 when the frame matches the
   picture, so the ordinary case is untouched — this only does anything when
   the two disagree, which is the case that was broken.
--------------------------------------------------------------------------- */

/** The scale at which `pic` fits inside `frame`, as a fraction of the frame's
    WIDTH, which is the unit every placement in here is in. */
function fitSizeFor(frame, pic) {
  if (!frame || !pic || !frame.w || !frame.h || !pic.w || !pic.h) return 1;
  // Drawn width is s·W and drawn height s·W·(ph/pw); fit the height, and never
  // blow a picture up past the frame's width to do it.
  return clamp(Math.min(1, (frame.h * pic.w) / (frame.w * pic.h)), 0.05, 1);
}

/** The size the puppet on the stage should arrive at. */
const fitPuppetSize = () => fitSizeFor(frameSize(), plateSize());

/** A placement authored against the PUPPET'S OWN PICTURE — which is what every
    mouth default is, because they were written when the frame and the picture
    were the same thing — moved onto the frame the puppet has landed on.

    `pose` is where the puppet sits; `frame` and `pic` their sizes. Returns the
    placement in the frame's fractions. Identity when the frame matches the
    picture and the puppet fills it. */
function onPuppetPlace(m, pose, frame, pic) {
  if (!m) return m;
  const s = (pose && pose.size) || 1;
  if (!frame || !pic || !frame.w || !frame.h || !pic.w || !pic.h) {
    return { x: m.x, y: m.y, size: m.size, rot: m.rot || 0 };
  }
  // The puppet's height, as a fraction of the frame's height.
  const vy = s * (frame.w / frame.h) * (pic.h / pic.w);
  return {
    x: ((pose && pose.x) == null ? 0.5 : pose.x) + (m.x - 0.5) * s,
    y: ((pose && pose.y) == null ? 0.5 : pose.y) + (m.y - 0.5) * vy,
    size: m.size * s,
    rot: m.rot || 0
  };
}

/** The same, for the puppet that is on the stage now. */
const onPuppet = m => onPuppetPlace(m, puppetPose, frameSize(), plateSize());

/** The frame a clip that is NOT open would be composed at: its own canvas
    record, the standing preference, or the app's default. */
function castClipFrame(clip) {
  const cv = (clip && clip.canvas) || canvasPreference ||
             (canvasSetting.mode === 'auto' ? null : canvasSetting);
  if (cv && cv.mode && cv.mode !== 'auto') {
    return { w: Math.max(16, Math.round(cv.w)), h: Math.max(16, Math.round(cv.h)) };
  }
  return null;        // match-the-puppet: the frame IS the picture, so size 1
}

function plateSize() {
  if (puppet.kind) return { w: puppet.w, h: puppet.h };
  if (state.video) return { w: state.video.w, h: state.video.h };
  return null;
}

/** The element to sample and to draw FROM — null while there is nothing, or
    while a video has not produced a frame yet. */
function plateSource() {
  if (puppet.kind === 'image') return puppet.img;
  if (puppet.kind === 'video') return plateVideo.videoWidth ? plateVideo : null;
  return state.video && player.videoWidth ? player : null;
}

/** Its own pixel size, which is what the blur patch has to sample at. */
function plateNatural() {
  const src = plateSource();
  if (!src) return null;
  return { w: src.videoWidth || src.naturalWidth, h: src.videoHeight || src.naturalHeight };
}

/** Where to look in a puppet for clip time `t`.

    A puppet shorter than the take PING-PONGS: out to its end, back to its
    start, out again. A plain loop cuts from the last frame to the first every
    time round and on a puppet that is a visible jolt; coming back the way it
    went has no seam in it at all. A puppet longer than the take simply has its
    tail left unused. */
function puppetTimeAt(t) {
  const d = puppet.duration;
  if (!(d > 0)) return 0;
  const end = Math.max(0, d - 0.001);
  if (d >= clipSeconds()) return Math.min(Math.max(0, t), end);
  const span = d * 2;
  const u = ((t % span) + span) % span;
  return Math.min(u <= d ? u : span - u, end);
}

/** Does this picture carry any transparency? Asked of the pixels, not of the
    file extension — most PNGs are opaque, and what matters for the export is
    whether there is anything worth keeping. */
function sampleAlpha(src, w, h) {
  if (!w || !h) return false;
  const s = Math.min(1, 160 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.clearRect(0, 0, cw, ch);
  try { x.drawImage(src, 0, 0, cw, ch); } catch (e) { return false; }
  let d;
  try { d = x.getImageData(0, 0, cw, ch).data; } catch (e) { return false; }
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/* ---- trimming the dead edge off a puppet --------------------------------------

   Pictures of puppets arrive with a lot of nothing round them. A phone photo of
   a minifigure on a desk, a PNG exported from a drawing app at canvas size, a
   scan — all of them put the subject in the middle of an acre of white or
   transparency. That costs twice: the mouth has to be shrunk to a few per cent
   of the frame to sit on a face that occupies a fifth of it, and every export
   that carries the puppet carries the empty margin at full resolution.

   So the border is measured and cut on the way in, and 20px of it is put back
   so nothing sits hard against the edge.

   Two ways of deciding what "empty" is, and which one applies is not a guess:
   a picture WITH transparency is trimmed on alpha, and one without is trimmed
   against the colour its own four corners agree on. If the corners disagree —
   a photograph with a real background, a gradient, anything with content out
   to the edge — nothing is cropped at all, which is the right answer for those
   and is also why this can run automatically without surprising anyone.
--------------------------------------------------------------------------- */
const CROP_MARGIN = 20;        // px of the ORIGINAL image, put back on each side

/** The content box, or null if there is nothing sensible to trim.

    Measured on a scaled-down copy and then scaled back up, because a 4000px
    photograph is 64 MB of ImageData and the bounding box does not need that
    kind of precision — it is padded by 20px afterwards anyway. */
function contentBox(img, w, h) {
  if (!w || !h) return null;
  const s = Math.min(1, 900 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.clearRect(0, 0, cw, ch);
  let d;
  try { x.drawImage(img, 0, 0, cw, ch); d = x.getImageData(0, 0, cw, ch).data; }
  catch (e) { return null; }   // a tainted canvas: say nothing, change nothing

  const at = (px, py) => (py * cw + px) * 4;
  let alpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 240) { alpha = true; break; }

  let test;
  if (alpha) {
    test = i => d[i + 3] > 24;
  } else {
    // The four corners have to agree before any of them counts as background.
    const cs = [at(0, 0), at(cw - 1, 0), at(0, ch - 1), at(cw - 1, ch - 1)];
    const far = (a, b) => Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) +
                          Math.abs(d[a + 2] - d[b + 2]);
    for (let k = 1; k < 4; k++) if (far(cs[0], cs[k]) > 30) return null;
    const br = d[cs[0]], bg = d[cs[0] + 1], bb = d[cs[0] + 2];
    // Generous, because a white background in a photograph is never one white:
    // it has a vignette, a shadow, and JPEG mottling in it.
    const tol = 34;
    test = i => Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > tol;
    // And remember it, so the padding put back matches the picture rather than
    // punching a transparent hole in an opaque one.
    contentBox.bg = 'rgb(' + br + ',' + bg + ',' + bb + ')';
  }
  if (alpha) contentBox.bg = null;

  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      if (!test(at(px, py))) continue;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
  }
  if (x1 < x0 || y1 < y0) return null;                  // the picture is empty
  const k = 1 / s;
  return {
    x: Math.max(0, Math.floor(x0 * k) - 1),
    y: Math.max(0, Math.floor(y0 * k) - 1),
    w: Math.min(w, Math.ceil((x1 + 1) * k) + 1) - Math.max(0, Math.floor(x0 * k) - 1),
    h: Math.min(h, Math.ceil((y1 + 1) * k) + 1) - Math.max(0, Math.floor(y0 * k) - 1),
    bg: contentBox.bg
  };
}

/** Crop `file` to its content plus a 20px margin. Resolves to a new File, or
    to null when there is nothing worth cutting — which is most photographs. */
async function cropToContent(file, force) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('no'));
      i.src = url;
    });
    const W = img.naturalWidth, H = img.naturalHeight;
    const b = contentBox(img, W, H);
    if (!b) return null;
    // Under a fortieth of the picture on every side is not worth a new file,
    // a changed name and an undo button.
    const cut = (W * H) - (b.w * b.h);
    if (!force && cut < W * H * 0.02) return null;
    if (force && cut < 4) return null;
    const m = CROP_MARGIN;
    const cw = b.w + m * 2, ch = b.h + m * 2;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d');
    // An opaque picture keeps an opaque margin in its own background colour; a
    // cut-out keeps its transparency, which every export downstream relies on.
    if (b.bg) { x.fillStyle = b.bg; x.fillRect(0, 0, cw, ch); }
    x.drawImage(img, b.x, b.y, b.w, b.h, m, m, b.w, b.h);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    if (!blob) return null;
    const name = file.name.replace(/\.[^.]+$/, '') + '-cropped.png';
    return { file: new File([blob], name, { type: 'image/png' }),
             from: { w: W, h: H }, to: { w: cw, h: ch },
             // Where the kept region sat in the original, so a placement made
             // before the trim can be moved with the picture rather than
             // sliding off the face.
             box: { x: b.x, y: b.y, m: m } };
  } catch (e) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function seekPlate(t) {
  return new Promise(res => {
    if (!plateVideo.src || !(plateVideo.duration > 0)) return res();
    if (Math.abs(plateVideo.currentTime - t) < 0.003) return res();
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      plateVideo.removeEventListener('seeked', fin);
      res();
    };
    plateVideo.addEventListener('seeked', fin);
    setTimeout(fin, 500);
    try { plateVideo.currentTime = t; } catch (e) { fin(); }
  });
}

/* A video puppet is never played, only seeked. Reverse playback is not a thing
   a <video> can do, and the ping-pong needs to run backwards half the time, so
   the one mechanism that works in both directions is the one used. Seeks are
   throttled during playback — the preview moves at about twenty a second
   rather than sixty — while the export seeks every frame exactly. */
let plateSeeking = false;
function syncPlate(t) {
  if (puppet.kind !== 'video') return;
  const want = puppetTimeAt(t);
  if (plateSeeking || Math.abs(plateVideo.currentTime - want) < 0.04) return;
  plateSeeking = true;
  seekPlate(want).then(() => { plateSeeking = false; if (!playing) drawStage(); });
}

/** Let go of the decoded picture. Deliberately says NOTHING about what the
    clip owns: this is called on the way in to restoring a clip's own puppet,
    and a version that cleared the record first destroyed the thing it was
    about to read. Forgetting is `forgetPuppet`, and only the Remove button and
    clearing the audio do it. */
function dropPuppet(quiet) {
  if (puppet.url) URL.revokeObjectURL(puppet.url);
  puppet.kind = null; puppet.name = ''; puppet.w = puppet.h = 0;
  puppet.duration = 0; puppet.alpha = false; puppet.url = null; puppet.img = null;
  // Detach the listeners before load(): calling load() with no src fires an
  // error event, and a stale one arriving mid-import rejects the NEXT puppet.
  plateVideo.onerror = null;
  plateVideo.removeAttribute('src');
  plateVideo.load();
  if (!quiet) {
    sizeStage();
    setExportsEnabled(state.frames.length > 0);
    updateEstimates();
  }
}

function forgetPuppet() {
  const c = activeClip();
  if (c) c.puppet = null;
  dropPuppet();
  pushStageHistory();
}

/** A photo or a video chosen as the backdrop. Read inside the page like
    everything else here: nothing is uploaded, and it goes when the clip does. */
async function setPuppet(file, quiet, opts) {
  if (!file) return false;
  const isImg = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name);
  const isVid = /^video\//.test(file.type) || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
  if (!isImg && !isVid) { toast('A puppet has to be a photo or a video.', 3800); return false; }
  // Trim the empty border before anything else looks at the picture, so the
  // cropped version is the one that gets decoded, placed, measured, banked on
  // the clip and shipped to Final Cut. Doing it later would leave the stage and
  // the export disagreeing about what the puppet is. `noCrop` is for restoring
  // a clip's own puppet, which was cropped when it first arrived.
  let original = null, trimmed = null;
  if (isImg && !(opts && opts.noCrop)) {
    trimmed = await cropToContent(file, !!(opts && opts.force));
    if (trimmed) { original = file; file = trimmed.file; }
  }
  dropPuppet(true);
  const url = URL.createObjectURL(file);
  try {
    if (isImg) {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('it would not decode as a picture'));
        i.src = url;
      });
      puppet.kind = 'image';
      puppet.img = img;
      puppet.w = img.naturalWidth; puppet.h = img.naturalHeight;
      puppet.duration = 0;
      puppet.alpha = sampleAlpha(img, puppet.w, puppet.h);
    } else {
      // Muted before anything else and never played: a puppet is a picture, and
      // two voice tracks at once is nobody's intention.
      plateVideo.muted = true;
      plateVideo.defaultMuted = true;
      await new Promise((res, rej) => {
        const ok = () => { cleanup(); res(); };
        const bad = () => { cleanup(); rej(new Error('it would not decode as a video')); };
        const cleanup = () => {
          plateVideo.removeEventListener('loadedmetadata', ok);
          plateVideo.removeEventListener('error', bad);
        };
        plateVideo.addEventListener('loadedmetadata', ok);
        plateVideo.addEventListener('error', bad);
        plateVideo.src = url;
        plateVideo.load();
      });
      plateVideo.pause();
      puppet.kind = 'video';
      puppet.w = plateVideo.videoWidth; puppet.h = plateVideo.videoHeight;
      puppet.duration = plateVideo.duration > 0 ? plateVideo.duration : 0;
      await seekPlate(Math.min(0.08, puppet.duration / 3));
      puppet.alpha = sampleAlpha(plateVideo, puppet.w, puppet.h);
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    dropPuppet(true);
    syncPuppetUI();
    toast('Could not use that puppet — ' + (e.message || e), 4400);
    return false;
  }
  puppet.url = url;
  puppet.name = file.name;
  puppet.uncropped = (opts && opts.uncropped) || original;
  puppet.cropped = !!puppet.uncropped;
  puppet.cropBox = (opts && opts.cropBox) || (trimmed && trimmed.box) || null;
  // A puppet arrives at the size of the frame it is landing on — the whole
  // frame when the canvas matches it, scaled to fit when it does not. Coming
  // back to one off the shelf, or reopening a clip, puts its own placement
  // back afterwards.
  if (!(opts && opts.keepPose)) {
    Object.assign(puppetPose, PUPPET_POSE, { size: fitPuppetSize() });
  }

  // A mouth sized as a fraction of the FRAME is wrong the moment the frame is
  // a portrait photograph: 30% of the width of a tall picture is a mouth wider
  // than the face it belongs to. Measured off the short edge instead, and only
  // when the placement is still the untouched default — then carried onto the
  // frame by whatever scale the puppet came in at, so a face at 42% of a 16:9
  // frame gets a mouth 42% of the size, in the same place on the face.
  const c = activeClip();
  if (Math.abs(overlay.size - 0.30) < 1e-9) {
    const short = Math.min(puppet.w, puppet.h);
    Object.assign(overlay, onPuppet({
      x: 0.5, y: 0.47, size: clamp(short * 0.17 / puppet.w, 0.05, 0.30), rot: 0
    }));
  }
  if (c) c.puppet = { file, kind: puppet.kind, uncropped: puppet.uncropped,
                     cropBox: puppet.cropBox };
  // On the shelf, so it can be come back to. A drawn face is already there and
  // shelfRemember knows to leave it alone.
  const shelved = shelfRemember(file, {
    uncropped: puppet.uncropped, cropBox: puppet.cropBox,
    // Kept so a character can be dealt onto a clip that is not open and still
    // be sized against that clip's frame.
    w: puppet.w, h: puppet.h,
    thumb: shelfThumb(puppet.kind === 'image' ? puppet.img : plateVideo,
                      puppet.w, puppet.h)
  });
  if (shelved && !shelved.pose) shelved.pose = { ...puppetPose };
  buildPuppetShelf();
  sizeStage();
  setExportsEnabled(state.frames.length > 0);
  updateEstimates();
  if (!quiet) {
    // Choosing a picture is a statement that the picture matters, so the
    // exports that can carry it start carrying it — all but the sprite sheet,
    // which is a bag of parts for an engine to assemble and is usually wanted
    // as mouths alone. Not done for a plate that is merely the clip's own
    // footage: those have always exported the mouth by itself and people rely
    // on that, so the boxes appear but stay clear.
    PLATE_BOXES.forEach(({ id, on }) => { const b = $(id); if (b) b.checked = on; });
    toast((puppet.kind === 'image' ? 'Puppet added' : 'Puppet added · ' +
          fmtTime(puppet.duration)) +
          (puppet.alpha ? ' · transparency kept where the format allows' : '') +
          (trimmed ? ' · trimmed to ' + trimmed.to.w + '×' + trimmed.to.h +
                     ' from ' + trimmed.from.w + '×' + trimmed.from.h : ''), 3200);
  }
  // Putting a picture behind the mouth is a step like any other, so it can be
  // taken back — including the one that replaced a puppet you wanted.
  pushStageHistory();
  return true;
}

/** Put the clip's own puppet back when it is opened again. The File is kept,
    not the decoded picture, so returning to a clip re-reads it — a dozen
    decoded photographs held at once is the kind of thing that ends a session
    on an iPad. */
let restoreToken = 0;
/** Settles when the puppet the last opened clip asked for is on the stage.
    `await awaitPlate()` after `openClip` is what makes an export see the same
    picture a person would. */
let plateReady = Promise.resolve();
const awaitPlate = () => plateReady;
async function restorePuppet(c) {
  const mine = ++restoreToken;
  const file = c && c.puppet && c.puppet.file;
  dropPuppet(true);
  if (file) {
    const keep = pose();
    const keepPuppetPose = { ...puppetPose };
    const ok = await setPuppet(file, true,
                               { noCrop: true, uncropped: c.puppet.uncropped,
                                 cropBox: c.puppet.cropBox, keepPose: true });
    Object.assign(puppetPose, keepPuppetPose);
    syncPlateTransform();
    // Clicking through the queue faster than a picture decodes would otherwise
    // land one clip's puppet on another's stage.
    if (mine !== restoreToken) return;
    // setPuppet may have picked a default size; the clip's own placement wins.
    if (ok) Object.assign(overlay, { x: keep.x, y: keep.y, size: keep.size, rot: keep.rot });
  }
  if (mine !== restoreToken) return;
  sizeStage();
  setExportsEnabled(state.frames.length > 0);
}

/** What the two mirror buttons say they are. Kept apart from the click
    handlers so that loading a clip, switching clips and pressing the button all
    end up showing the same thing. */
function syncMirrorUI() {
  const lb = $('flipLips'), pb = $('plateFlip'), st = $('flipLipsState');
  if (lb) lb.setAttribute('aria-pressed', mirror.lips ? 'true' : 'false');
  if (pb) pb.setAttribute('aria-pressed', mirror.plate ? 'true' : 'false');
  // Said in words as well as in the button's state, because "pressed" on a
  // small button is exactly the thing people miss.
  if (st) st.textContent = mirror.lips ? 'Lips flipped' : 'Flip lips';
}

/** The puppet rows in the Input tab. Before there is a puppet the invite row
    offers one; after, the plate row says which. "Add a puppet…" is under both,
    because adding a SECOND character is the thing a row of Replace/Remove
    cannot say — and not being able to find it is exactly what was reported. */
function syncPuppetUI() {
  const row = $('plateRow'), invite = $('puppetInvite');
  const plate = hasPlate();
  // One place decides what a plate turns on, so adding a puppet and loading a
  // video cannot end up enabling different things.
  overlayToolsVisible(placeable());
  if (invite) invite.hidden = plate || !state.frames.length;
  const addRow = $('puppetAddRow');
  if (addRow) addRow.hidden = !state.frames.length;
  if (row) {
    row.hidden = !puppet.kind;
    if (puppet.kind) {
      $('plateName').textContent = puppet.name;
      $('plateMeta').textContent = puppet.w + '×' + puppet.h + ' · ' +
        (puppet.kind === 'image' ? 'still' : fmtTime(puppet.duration)) +
        (puppet.alpha ? ' · transparent' : '') +
        (puppet.cropped ? ' · trimmed' : '');
      // Only a still can be trimmed: the measurement is of one frame and a
      // video's subject moves out of it.
      const crop = $('plateCrop');
      if (crop) {
        crop.hidden = puppet.kind !== 'image';
        crop.textContent = puppet.cropped ? 'Undo trim' : 'Trim edges';
        crop.title = puppet.cropped
          ? 'Put the original picture back, margins and all'
          : 'Cut the empty border off, leaving a 20px margin';
      }
    }
  }
  const wrap = $('stageWrap');
  if (wrap) {
    wrap.classList.toggle('p-img', puppet.kind === 'image');
    wrap.classList.toggle('p-vid', puppet.kind === 'video');
    wrap.classList.toggle('alpha', !frameIsOpaque());
    wrap.classList.toggle('flip-plate', mirror.plate && hasPlate());
  }
  syncMirrorUI();
  syncPlateTransform();
  // The puppet layer cannot be the one being edited when there is no puppet.
  syncLayers();
  syncCanvasUI();
  syncFacePick();
  const note = $('puppetShortNote');
  if (note) {
    const short = puppet.kind === 'video' && puppet.duration > 0 &&
                  puppet.duration < clipSeconds() - 0.05;
    note.hidden = !short;
    if (short) {
      note.textContent = 'The puppet is shorter than the take, so it plays out and ' +
        'back again — ' + fmtTime(puppet.duration) + ' against ' + fmtTime(clipSeconds()) +
        '. The preview steps through the reverse half; the export renders every frame of it.';
    }
  }
  // Hidden when there is nothing behind the mouth, but NOT cleared. Clearing
  // them looked tidy and quietly broke the queue: clicking a clip that has no
  // puppet emptied the boxes, and clicking back restored the puppet but not the
  // ticks, so a batch run exported every clip without the puppet the user had
  // just put on it. `plateOn` already refuses a ticked box with no plate under
  // it, so there was never anything for the clearing to protect against.
  PLATE_BOXES.forEach(({ id }) => {
    const b = $(id);
    const lab = b && b.closest('label');
    if (lab) lab.hidden = !hasStack();
  });
  // The effects box appears on the same terms: the boil and the shadows are
  // things layers have, so with nothing on the stage there is nothing to ask
  // about. The overlay card's own pair is handled with that card.
  FX_BOXES.forEach(id => {
    if (id === 'ovFx') return;
    const b = $(id);
    const lab = b && b.closest('label');
    if (lab) lab.hidden = !hasStack();
  });
}

function sizeStage() {
  const c = $('stage');
  // Whatever is behind the mouth decides the shape of the stage. Left keyed to
  // state.video, a portrait photograph was letterboxed inside a square.
  const vid = frameHasContent() ? frameSize() : null;
  const long = 640;
  if (vid) {
    const s = long / Math.max(vid.w, vid.h);
    c.width = Math.round(vid.w * s);
    c.height = Math.round(vid.h * s);
    c.style.aspectRatio = '';
    c.style.width = '';
    // Cap the HEIGHT too, via the width that produces it. The stage has the
    // wide column now, and a portrait clip given all of it would push the
    // exposure sheet under it clean off the screen — which is the one thing
    // the two-thirds layout exists to prevent. Capping width keeps the video
    // and the canvas over it sized by exactly the same rule, which is what
    // keeps them aligned.
    const capH = Math.max(300, Math.min(620, Math.round(window.innerHeight * 0.46)));
    $('stageStack').style.maxWidth = Math.round(Math.min(
      760 * (vid.w >= vid.h ? 1 : vid.w / vid.h),
      capH * (vid.w / vid.h))) + 'px';
    // And tell the stack its SHAPE. In this mode every child is out of flow —
    // the canvas by the stylesheet, the two video elements because
    // syncPlateTransform places them by hand — so left to itself the stack is
    // 0px high and the canvas, stretched to inset:0 inside it, renders at
    // zero height with a perfectly good picture in its backing store. That is
    // what showed as a loaded puppet and an empty checkerboard. It used to
    // work by accident: the clip's own <video> was the one in-flow child, so a
    // still picture lost the only thing holding the box open.
    $('stageStack').style.aspectRatio = c.width + ' / ' + c.height;
  } else {
    c.width = c.height = 472;
    c.style.aspectRatio = '1 / 1';
    c.style.width = 'min(480px, 100%)';
    $('stageStack').style.maxWidth = '';
    $('stageStack').style.aspectRatio = '';
  }
  $('stageWrap').classList.toggle('video', !!vid);
  syncPuppetUI();
  drawStage();
}

/** The overlay box in stage-canvas pixels. `rot` is radians about (cx,cy);
    x/y remain the UNROTATED top-left, because every bit of drawing and hit
    testing happens in the box's own frame, where rotation has already been
    taken out. */
function overlayBox(W, H, p) {
  p = p || livePose();
  const s = p.size * W;
  return {
    s, cx: p.x * W, cy: p.y * H, rot: p.rot * Math.PI / 180,
    x: p.x * W - s / 2, y: p.y * H - s / 2,
  };
}

/** The puppet's box on the stage: the whole frame, moved and scaled and turned
    by its own placement. Not square, unlike the mouth's — which is why the
    handles below take a width and a height rather than one side. */
function plateBox(W, H) {
  return {
    s: W * puppetPose.size, w: W * puppetPose.size, h: H * puppetPose.size,
    cx: puppetPose.x * W, cy: puppetPose.y * H,
    rot: puppetPose.rot * Math.PI / 180
  };
}

/** Where a mouth placement ends up when the puppet under it moves from `p0` to
    `p1`. The mouth belongs to the face: place it on the chin, then decide the
    face is too big, and if the mouth stayed where it was you would have to
    place it again. So it is carried — moved, scaled and turned by exactly the
    change applied to the picture.

    THE MOUTH AND NOTHING ELSE. This once ran over every layer in the stack,
    on the theory that anything sitting on the puppet had been placed in
    relation to it. It is not true, and it made the puppet unadjustable: nudge
    the character and every caption, prop and background in the frame slid with
    it. The mouth is the one layer that is genuinely part of the face.

    Worked in pixels rather than in the frame's own fractions, because a
    rotation mixes x into y and the two axes are not the same number of pixels
    per unit. The frame size cancels out of the final answer, which is why any
    W and H give the same result. */
function remapWithPuppet(p0, p1, m, W, H) {
  const k = p1.size / p0.size;
  const d = (p1.rot - p0.rot) * Math.PI / 180;
  const cs = Math.cos(d), sn = Math.sin(d);
  const dx = m.x * W - p0.x * W, dy = m.y * H - p0.y * H;
  return {
    x: (p1.x * W + (dx * cs - dy * sn) * k) / W,
    y: (p1.y * H + (dx * sn + dy * cs) * k) / H,
    size: m.size * k,
    rot: normDeg(m.rot + (p1.rot - p0.rot))
  };
}

/** Whichever layer the handles are driving — which is whichever is selected in
    the Layers list. The two names below are the only thing left of the older
    two-layer world, and they now mean "the selected layer". */
function activeBox(W, H) {
  return boxForLayer(selectedLayer(), W, H);
}

/** Any layer's box, by the same rule the handles use. */
function boxForLayer(L, W, H) {
  if (!L) return overlayBox(W, H);
  return L.kind === 'mouth' ? overlayBox(W, H) : layerBox(L, W, H);
}

/** Which layer is under a point on the stage.

    SMALLEST BOX WINS, not topmost. Topmost is what a drawing program does and
    it is wrong here: a background picture is usually the whole frame, so
    topmost makes the mouth — the one thing this app exists to move —
    unclickable the moment anything is added above it. That is exactly what was
    reported: add a few pictures and "I could not resize or move the mouth".
    The pointer never selected anything at all, so the handles stayed on
    whichever layer had been selected last, and a full-frame picture's move box
    covers every pixel of the stage.

    Smallest-first gives the obvious answer in every case that comes up: the
    mouth beats the puppet behind it, a logo beats the picture it sits on, and
    the plate — being the whole frame — is what you get when you click bare
    background. Topmost only breaks ties. */
function layerAtPoint(p, W, H) {
  let best = null, bestArea = Infinity;
  layers.forEach((L, i) => {
    if (!L.visible) return;
    const b = boxForLayer(L, W, H);
    const g = { hw: (b.w != null ? b.w : b.s) / 2, h: (b.h != null ? b.h : b.s) / 2 };
    const l = overlayLocal(p, b);
    if (Math.abs(l.x) > g.hw || Math.abs(l.y) > g.h) return;
    const area = g.hw * g.h;
    if (area < bestArea - 1e-6 || (Math.abs(area - bestArea) <= 1e-6 && best && i > best.i)) {
      best = { L, i }; bestArea = area;
    }
  });
  return best && best.L;
}
function activePose() {
  return layerPose(selectedLayer()) || overlay;
}
function activeIsPlate() {
  const L = selectedLayer();
  return !!L && L.kind === 'plate';
}

/* ---------------------------------------------------------------- motion

   A pose is the whole placement at one instant: x, y, size, angle. Keyframes
   store complete poses rather than deltas, so any key can be read on its own
   without replaying the ones before it, and deleting one in the middle cannot
   corrupt the rest. */

function pose() {
  return { x: overlay.x, y: overlay.y, size: overlay.size, rot: overlay.rot };
}

/* The mouth has ONE placement for the whole clip.

   There used to be keyframes here: set a key, scrub, drag, set another, and
   the mouth interpolated between them to follow a moving shot. It was removed
   on the 19th — "it doesn't work very well and is taking up space" — and the
   honest reason it did not work well is that a mouth tracking a head is a
   tracking problem, and linear interpolation between hand-set keys is not a
   tracker. The overlay video is the answer for footage that moves: it burns
   the mouth onto the picture, and a real editor keyframes it from there.

   `poseAt` survives as a name because a dozen call sites — every export, the
   compositor, the warm-up — ask for "the pose at this frame" and should not
   have to know whether that can vary. */
function poseAt() { return pose(); }

/** What the stage should be showing right now. */
function livePose() { return pose(); }

/* ------------------------------------------------------------- blur patch

   A doll or a minifigure already has a mouth printed on it, and a drawn mouth
   laid on top of a painted one reads as two mouths. This blurs the picture
   underneath before the drawn mouth goes down.

   It has to be a real blur of the frame, not a painted-on colour, or it will
   not sit in the shot — so it samples the video and feathers to nothing at the
   rim. A hard-edged patch reads as a sticker, which is the thing being fixed. */

/* The blur itself is done by shrinking the region and growing it back, not by
   ctx.filter. Safari reports canvas filters as supported and then declines to
   apply them when the source is a <video>, which drew a sharp copy of the
   picture — a patch that hid nothing, with no error to notice. Resampling is
   plain drawImage: every browser has it, and it looks the same in all of them.

   Halving repeatedly and expanding back is a far better blur than one big
   downscale, which leaves visible blocks. */
let blurA = null, blurB = null;
function blurPair(w, h) {
  if (!blurA) { blurA = document.createElement('canvas'); blurB = document.createElement('canvas'); }
  if (blurA.width !== w || blurA.height !== h) {
    blurA.width = blurB.width = w;
    blurA.height = blurB.height = h;
  }
  return [blurA, blurB];
}

function rescaleInto(dst, src, sw, sh, dw, dh) {
  const c = dst.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.clearRect(0, 0, dw, dh);
  c.drawImage(src, 0, 0, sw, sh, 0, 0, dw, dh);
}

/** Draws the patch onto ctx for the placement `b`. Sampling comes from the
    video element, never from ctx: on the stage the picture lives in a <video>
    underneath a transparent canvas, so there is nothing on the canvas to
    blur. Using the same source in the export keeps one code path. */
function drawBlurPatch(ctx, W, H, b) {
  const plate = plateSource(), nat = plateNatural();
  if (!patch.on || !plate || !nat) return;
  const rx = Math.max(2, patch.cover * b.s / 2), ry = rx * 0.72;
  const blurPx = patch.blur * W * 0.05;
  if (blurPx < 0.4) return;

  const ext = Math.ceil(Math.max(rx, ry)) + Math.ceil(blurPx * 3) + 2;
  const x0 = Math.max(0, Math.round(b.cx - ext)), y0 = Math.max(0, Math.round(b.cy - ext));
  const x1 = Math.min(W, Math.round(b.cx + ext)), y1 = Math.min(H, Math.round(b.cy + ext));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return;

  const [A, B] = blurPair(w, h);
  const sx = nat.w / W, sy = nat.h / H;
  const a0 = A.getContext('2d');
  a0.setTransform(1, 0, 0, 1, 0, 0);
  a0.globalCompositeOperation = 'source-over';
  a0.clearRect(0, 0, w, h);
  // The piece lifted has to come from where the picture REALLY is, which is
  // wherever the puppet's placement put it — mirrored, moved, scaled, turned.
  // Mapping the patch rectangle back through the inverse by hand worked while
  // the only transform was a mirror and would not survive a rotation, so the
  // whole frame is drawn through the same transform the exports use and the
  // patch canvas simply catches the part of it that lands inside.
  const pzn = plateSize() || nat;
  const fits = !puppetMoved() && !mirror.plate &&
               Math.abs(pzn.w / pzn.h - W / H) < 1e-3;
  if (!fits) {
    const pw = puppetPose.size * W;
    const ph = pw * (pzn.h / Math.max(1, pzn.w));
    a0.save();
    a0.translate(-x0, -y0);
    a0.translate(puppetPose.x * W, puppetPose.y * H);
    a0.rotate(puppetPose.rot * Math.PI / 180);
    if (mirror.plate) a0.scale(-1, 1);
    a0.drawImage(plate, -pw / 2, -ph / 2, pw, ph);
    a0.restore();
  } else {
    a0.drawImage(plate, x0 * sx, y0 * sy, w * sx, h * sy, 0, 0, w, h);
  }

  // Each halving roughly doubles the blur, so the step count is the log of the
  // radius asked for.
  const steps = Math.max(1, Math.min(6, Math.round(Math.log2(Math.max(2, blurPx)))));
  let src = A, dst = B, cw = w, ch = h;
  for (let i = 0; i < steps; i++) {
    const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
    rescaleInto(dst, src, cw, ch, nw, nh);
    const sw = src; src = dst; dst = sw; cw = nw; ch = nh;
  }
  for (let i = 0; i < steps; i++) {
    const nw = Math.min(w, cw * 2), nh = Math.min(h, ch * 2);
    rescaleInto(dst, src, cw, ch, nw, nh);
    const sw = src; src = dst; dst = sw; cw = nw; ch = nh;
  }

  const tmp = src;
  const t = tmp.getContext('2d');
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'destination-in';
  t.translate(b.cx - x0, b.cy - y0);
  t.rotate(b.rot);
  t.scale(1, ry / rx);
  // Solid over most of it, feathering only at the rim: this is covering
  // something up, so a wide soft ramp would let the printed mouth show through
  // the middle of the very patch meant to hide it.
  const g = t.createRadialGradient(0, 0, rx * 0.75, 0, 0, rx);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  t.fillStyle = g;
  t.beginPath(); t.arc(0, 0, rx, 0, Math.PI * 2); t.fill();
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.globalCompositeOperation = 'source-over';

  ctx.drawImage(tmp, x0, y0);
}

/** A stage-canvas point in the box's own frame, centred on the box. Undoing
    the rotation once here means the hit tests stay the plain rectangle
    comparisons they were before the box could turn. */
function overlayLocal(p, b) {
  const dx = p.x - b.cx, dy = p.y - b.cy;
  const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Where the handles sit, in that same frame. Drawing and hit testing both
    read this one function, so a handle can never be drawn somewhere you
    cannot grab it. */
function overlayHandles(b, W, H) {
  // Half-width and half-height. A square box has one number; the puppet's box
  // is the frame's shape, so it has two, and `h` stays the vertical one so
  // every existing use of it still means what it meant.
  const hw = (b.w == null ? b.s : b.w) / 2;
  const h = (b.h == null ? b.s : b.h) / 2;
  const hs = Math.max(9, W * 0.022);
  const arm = Math.max(hs * 1.9, W * 0.055);      // how far the turn knob stands off
  // It stands off the top edge, but a mouth placed high in the frame would put
  // it past the top of the canvas, where no pointer can reach it. Flip it to
  // the far side when that happens.
  let ty = -h - arm;
  if (H != null && b.cy + ty * Math.cos(b.rot) < hs * 1.4) ty = h + arm;

  // ALL FOUR corners, each pulled back inside the canvas when the layer is
  // bigger than the frame. A picture that arrives oversized has its real
  // corners off the edge of the stage, where no pointer can reach them — so
  // the only way to shrink it was the slider, which is what "it is difficult
  // to resize it" was describing. Scaling is computed as a RATIO from wherever
  // the handle was grabbed, so moving the grab point inward along its own ray
  // costs nothing: the drag still means the same thing, and that is also what
  // lets any of the four corners drive the same gesture. One corner meant
  // reaching round the picture for the bottom-right every time, even when the
  // top-left was the one in front of you.
  const CORNERS = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const c0 = Math.cos(b.rot), s0 = Math.sin(b.rot);
  const m = hs * 1.2;
  const pullIn = (x, y) => {
    if (W == null || H == null) return { x, y };
    const dx = x * c0 - y * s0, dy = x * s0 + y * c0;
    let t = 1;
    const lim = (d, pos, lo, hi) => {
      if (d > 1e-6) t = Math.min(t, (hi - pos) / d);
      else if (d < -1e-6) t = Math.min(t, (lo - pos) / d);
    };
    lim(dx, b.cx, m, W - m);
    lim(dy, b.cy, m, H - m);
    if (t < 1) { t = Math.max(t, 0.06); return { x: x * t, y: y * t }; }
    return { x, y };
  };
  const corners = CORNERS.map(([ux, uy]) => pullIn(ux * hw, uy * h));
  const sx = corners[0].x, sy = corners[0].y;
  if (W != null && H != null) {
    const s2 = s0, c = c0;
    // And the knob, for the same reason. Turning is computed from the ANGLE
    // about the centre, so pulling the knob in along its own line leaves the
    // gesture meaning exactly what it did.
    const kx = -ty * s2, ky = ty * c;
    let kt = 1;
    const klim = (d, pos, lo, hi) => {
      if (d > 1e-6) kt = Math.min(kt, (hi - pos) / d);
      else if (d < -1e-6) kt = Math.min(kt, (lo - pos) / d);
    };
    klim(kx, b.cx, m, W - m);
    klim(ky, b.cy, m, H - m);
    if (kt < 1) ty *= Math.max(kt, 0.06);
  }
  // `scale` is the bottom-right one, kept as its own name because that is the
  // corner everything was written against.
  return { h, hw, hs, arm, corners, scale: { x: sx, y: sy }, turn: { x: 0, y: ty } };
}

/** Degrees wrapped to (-180, 180], so the readout never shows 359. Half a
    turn reads as 180 rather than -180: they are the same angle, and the
    positive one is what a person expects to see after turning clockwise. */
function normDeg(d) {
  d = ((d + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return Object.is(d, -0) ? 0 : d;
}

/* ==== layers =================================================================

   Until now the picture was one thing: a puppet with a mouth on it. That is the
   common job and it stays the easy one — load a photograph, the mouth goes on
   it, nothing here is in the way. But a hat, a speech bubble, a name plate, a
   second character, a coloured ground behind a cut-out: all of those were
   "open it in something else afterwards", and afterwards is where a lip sync
   stops being editable.

   So the picture is a STACK now. Pictures, text, shapes, and the mouth itself,
   in an order you choose, each with its own placement and its own visibility.

   Two rules that are not arbitrary:

   - `layers` is stored BOTTOM-FIRST, because that is the order it is drawn in
     and drawing order is the thing the code cares about. The panel shows it
     reversed, because top-of-the-pile is what a person means by "the top
     layer". Every editor does this and every editor gets the same bug reports
     when it does not.

   - A VIDEO layer is pinned to the back. Not a design preference: Safari will
     not reliably draw a hidden <video> into a canvas, so the one video has to
     stay a real element underneath the stage canvas, and anything underneath
     that element cannot be drawn by us at all. Pictures have no such problem
     and move freely.

   The mouth is a layer like any other, so a hand or a moustache can cross in
   front of it. It keeps what only it has — the keyframes, and the blur patch
   that hides a printed mouth on whatever is behind it.
--------------------------------------------------------------------------- */

let layers = [];
let selectedLayerId = null;
let layerSeq = 0;

const LAYER_KIND_LABEL = {
  plate: 'Puppet', mouth: 'Mouth', image: 'Picture', text: 'Text', shape: 'Shape'
};

const newLayerId = () => 'L' + (++layerSeq);

/** The pose a layer is placed by. The puppet and the mouth keep theirs in the
    objects the rest of the app already reads and writes, so there is one copy
    of each rather than two that have to be kept in step. */
function layerPose(L) {
  if (!L) return null;
  if (L.kind === 'plate') return puppetPose;
  if (L.kind === 'mouth') return overlay;
  return L.pose;
}

/** Height over width of the box this layer draws in. The one number that lets
    every kind share a single placement model: a box is `size * W` wide and
    that times `ar` tall. */
function layerAR(L, W, H) {
  if (L.kind === 'plate') {
    // Its OWN shape, not the frame's. While the frame was always the puppet's
    // size the two were the same number; with a frame you can choose they are
    // not, and using the frame's would stretch a portrait puppet across a
    // landscape delivery.
    const pz = plateSize();
    return pz && pz.w ? pz.h / pz.w : 1;
  }
  if (L.kind === 'mouth') return 1;
  if (L.kind === 'image') {
    const im = L.img;
    return im && im.naturalWidth ? im.naturalHeight / im.naturalWidth : 1;
  }
  if (L.kind === 'text') return L.measuredAR || 0.3;
  return L.ar || 0.6;
}

/** The layer's box on the stage, in canvas pixels. Same shape as the mouth's
    box has always been, so the handles, the hit testing and the drawing all go
    on working unchanged. */
function layerBox(L, W, H) {
  const p = layerPose(L);
  if (!p) return null;
  const w = p.size * W, h = w * layerAR(L, W, H);
  return { s: w, w, h, cx: p.x * W, cy: p.y * H, rot: p.rot * Math.PI / 180 };
}

const layerById = id => layers.find(L => L.id === id) || null;
const selectedLayer = () => layerById(selectedLayerId);
const mouthLayer = () => layers.find(L => L.kind === 'mouth') || null;
const plateLayer = () => layers.find(L => L.kind === 'plate') || null;

/** Is this layer stuck at the back? Only a moving picture is. */
function layerPinned(L) {
  return L.kind === 'plate' && (puppet.kind === 'video' || (!puppet.kind && !!state.video));
}

/** Rebuild the stack so it matches what is loaded, keeping every placement and
    every extra layer that is already in it. Called whenever a puppet arrives or
    goes; everything else edits `layers` directly. */
function syncLayers() {
  const had = layers.length;
  /* A mouth exists when there is something for it to belong to: a voice
     track, a puppet, or a stack somebody has started building. Otherwise the
     stage is empty and so is the list.

     Without that last clause, clearing the audio put the mouth straight back:
     `clearAudio` emptied the stack and the very next `syncPuppetUI` added a
     fresh mouth layer to it, which is how the lips went on sitting on an
     empty stage after the voice they belonged to had gone. */
  const anything = hasPlate() || !!state.buffer || state.frames.length > 0 ||
                   layers.some(L => L.kind !== 'mouth');
  if (!anything) {
    if (layers.length) { layers = []; renderLayerPanel(); }
    return;
  }
  if (!layers.some(L => L.kind === 'mouth')) {
    layers.push({ id: newLayerId(), kind: 'mouth', name: 'Mouth', visible: true });
  }
  const plate = plateLayer();
  if (hasPlate() && !plate) {
    // At the back, under everything that was already there.
    layers.unshift({ id: newLayerId(), kind: 'plate', name: 'Puppet', visible: true });
  } else if (!hasPlate() && plate) {
    layers = layers.filter(L => L !== plate);
  }
  // A pinned video has to be at index 0 whatever else has happened.
  const p = plateLayer();
  if (p && layerPinned(p) && layers[0] !== p) {
    layers = [p, ...layers.filter(L => L !== p)];
  }
  if (p) p.name = puppet.name ? puppet.name.replace(/\.[^.]+$/, '') : 'Puppet';
  if (!selectedLayerId || !layerById(selectedLayerId)) {
    const m = mouthLayer();
    selectedLayerId = m ? m.id : (layers[0] ? layers[0].id : null);
  }
  if (!had) selectedLayerId = (mouthLayer() || {}).id || selectedLayerId;
  renderLayerPanel();
}

/* ---- drawing one layer ---------------------------------------------------- */

/** Text has no intrinsic size, so its box is measured from the string at the
    size it will be drawn. Cached on the layer, because this runs per frame. */
function measureTextLayer(ctx, L, W) {
  const px = Math.max(4, layerPose(L).size * W);
  const lines = String(L.text || '').split('\n');
  ctx.save();
  ctx.font = textLayerFont(L, px);
  let wide = 1;
  lines.forEach(s => { wide = Math.max(wide, ctx.measureText(s || ' ').width); });
  ctx.restore();
  const lineH = px * 1.22;
  const h = lineH * lines.length;
  L.measuredAR = h / Math.max(1, wide);
  return { lines, px, lineH, wide, h };
}

function textLayerFont(L, px) {
  const fam = L.font === 'mono' ? "'DM Mono',ui-monospace,monospace"
            : L.font === 'serif' ? 'ui-serif,Georgia,serif'
            : "'Archivo',system-ui,sans-serif";
  return (L.weight || 600) + ' ' + px.toFixed(1) + 'px ' + fam;
}

function drawTextLayer(ctx, L, W, H) {
  const p = layerPose(L);
  const m = measureTextLayer(ctx, L, W);
  ctx.save();
  ctx.translate(p.x * W, p.y * H);
  ctx.rotate(p.rot * Math.PI / 180);
  ctx.font = textLayerFont(L, m.px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y0 = -m.h / 2 + m.lineH / 2;
  if (L.stroke && L.strokeW > 0) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = L.stroke;
    ctx.lineWidth = m.px * L.strokeW;
    m.lines.forEach((s, i) => ctx.strokeText(s, 0, y0 + i * m.lineH));
  }
  ctx.fillStyle = L.color || '#FFFFFF';
  m.lines.forEach((s, i) => ctx.fillText(s, 0, y0 + i * m.lineH));
  ctx.restore();
}

/* ---- shapes, and the comic furniture ----------------------------------------

   A balloon is a shape with a tail and words in it, not a picture you go and
   draw somewhere else. Everything here is built as ONE path where it can be —
   body and tail together — because a tail filled separately leaves the join
   line showing straight through the balloon, which is the tell that says
   "clip art" the moment the outline is more than a hairline.

   Every shape is drawn from the layer's own numbers, so an export is the
   preview at a different size rather than a different picture.
---------------------------------------------------------------------------- */

const SHAPE_KINDS = [
  ['rect', 'Rectangle'], ['ellipse', 'Ellipse'],
  ['speech', 'Speech balloon'], ['thought', 'Thought balloon'],
  ['burst', 'Shout burst'], ['whisper', 'Whisper balloon'],
  ['caption', 'Caption panel'], ['banner', 'Banner'],
];
/** The ones that carry a tail aimed at whoever is speaking. */
const BALLOON_KINDS = ['speech', 'thought', 'burst', 'whisper'];
const isBalloon = L => BALLOON_KINDS.indexOf(L.shape) >= 0;
/** The ones that hold words. */
const SHAPE_HOLDS_WORDS = ['speech', 'thought', 'burst', 'whisper', 'caption', 'banner'];
const shapeHoldsWords = L => SHAPE_HOLDS_WORDS.indexOf(L.shape) >= 0;

/** A steady wobble, so a hand-drawn edge is the same hand every time it is
    drawn. The same idea as the line boil's noise: deterministic, or an export
    would not match its own preview. */
function shapeWobble(seed, i) {
  const x = Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Lines broken to fit a width, honouring the ones the user broke by hand. */
function wrapLines(ctx, text, maxW) {
  const out = [];
  String(text == null ? '' : text).split('\n').forEach(para => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); return; }
    let line = '';
    words.forEach(word => {
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > maxW) { out.push(line); line = word; }
      else line = next;
    });
    out.push(line);
  });
  return out;
}

/** The outline of one balloon or panel, as a path in its own centred frame. */
function shapePath(ctx, L, w, h) {
  const rx = w / 2, ry = h / 2;
  const kind = L.shape || 'rect';
  const seed = L.seed == null ? 1 : L.seed;
  // Where the tail points, and how far it reaches. Degrees clockwise from the
  // right, which is how the editor says it.
  const ta = (L.tailAt == null ? 125 : L.tailAt) * Math.PI / 180;
  const len = clamp(L.tailLen == null ? 0.55 : L.tailLen, 0, 2);

  if (kind === 'rect' || kind === 'caption' || kind === 'banner') {
    const r = kind === 'caption' ? 0
            : kind === 'banner' ? Math.min(w, h) * 0.04
            : Math.min(w, h) * clamp(L.radius == null ? 0.08 : L.radius, 0, 0.5);
    if (kind === 'banner') {
      // A ribbon: a box with a notch bitten out of each end.
      const n = Math.min(w * 0.12, h * 0.6);
      ctx.beginPath();
      ctx.moveTo(-rx, -ry);
      ctx.lineTo(rx, -ry);
      ctx.lineTo(rx - n, 0);
      ctx.lineTo(rx, ry);
      ctx.lineTo(-rx, ry);
      ctx.lineTo(-rx + n, 0);
      ctx.closePath();
      return;
    }
    ctx.beginPath();
    roundRect(ctx, -rx, -ry, w, h, r);
    return;
  }

  if (kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    return;
  }

  if (kind === 'burst') {
    // A shout: points all the way round, long and short alternating, with a
    // steady wobble so it is not a machined star. The tail is one point pulled
    // out further than the rest, which is how a shout balloon is drawn.
    const pts = Math.max(6, Math.round(L.spikes == null ? 12 : L.spikes));
    const inner = clamp(L.spikeDepth == null ? 0.72 : L.spikeDepth, 0.3, 0.95);
    ctx.beginPath();
    const N = pts * 2;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      let k = (i % 2 === 0 ? 1 : inner) * (1 + 0.06 * shapeWobble(seed, i));
      // the one long point, aimed where the tail is aimed
      let d = Math.abs(((a - ta + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (len > 0 && d > Math.PI - 0.26 && i % 2 === 0) k = 1 + len;
      const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    return;
  }

  // speech / thought / whisper: an oval body with a gap, the tail across it.
  const spread = clamp(L.tailWide == null ? 0.26 : L.tailWide, 0.06, 0.9);
  const a1 = ta + spread, a2 = ta - spread + Math.PI * 2;
  ctx.beginPath();
  if (kind === 'thought') {
    // A cloud: a ring of overlapping bumps, each one an ARC centred on the rim
    // rather than a dent in a polygon. A wobbled radius only ever gives a
    // slightly lumpy oval — a thought balloon is round bumps, and the outline
    // has to curve back on itself between them.
    const bumps = Math.max(7, Math.round(L.bumps == null ? 11 : L.bumps));
    const span = a2 - a1;
    const step = span / bumps;
    const k0 = 0.82;
    const at = i => {
      const a = a1 + step * i;
      const k = k0 + 0.025 * shapeWobble(seed, i);
      return { a, x: Math.cos(a) * rx * k, y: Math.sin(a) * ry * k };
    };
    // Each bump is only drawn between where it meets its neighbours. Sweeping
    // further is what leaves the little hooks inside the outline: the arc runs
    // on behind the next bump and the line back out cuts across it.
    for (let i = 0; i <= bumps; i++) {
      const c = at(i), n = at(i + 1 > bumps ? i - 1 : i + 1);
      const d = Math.hypot(n.x - c.x, n.y - c.y);
      const br = d * 0.78;
      const half = Math.PI / 2 - Math.acos(clamp(d / (2 * br), 0, 1));
      ctx.arc(c.x, c.y, br * (1 + 0.1 * shapeWobble(seed, i + 40)),
              c.a - half * 1.25, c.a + half * 1.25);
    }
  } else {
    ctx.ellipse(0, 0, rx, ry, 0, a1, a2, false);
  }
  if (len > 0 && kind !== 'thought') {
    // The tail: out to a tip, and back to the far lip of the gap. Drawn as
    // part of the body's own path so the join never shows.
    const tipR = 1 + len;
    const tx = Math.cos(ta) * rx * tipR, ty2 = Math.sin(ta) * ry * tipR;
    if (kind === 'whisper') {
      // A whisper trails off: the tail is a slim, hooked flick.
      ctx.quadraticCurveTo(Math.cos(ta - spread * 0.2) * rx * (1 + len * 0.6),
                           Math.sin(ta - spread * 0.2) * ry * (1 + len * 0.6), tx, ty2);
    } else {
      ctx.lineTo(tx, ty2);
    }
  }
  ctx.closePath();
}

/** The bubbles that trail off a thought balloon — their own paths, because
    they are their own shapes. */
function thoughtTrail(L, w, h) {
  const ta = (L.tailAt == null ? 125 : L.tailAt) * Math.PI / 180;
  const len = clamp(L.tailLen == null ? 0.55 : L.tailLen, 0, 2);
  if (len <= 0) return [];
  const rx = w / 2, ry = h / 2;
  const out = [];
  const n = 3;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const k = 1 + len * t * 0.95;
    out.push({
      x: Math.cos(ta) * rx * k,
      y: Math.sin(ta) * ry * k,
      r: Math.min(rx, ry) * 0.17 * (1 - t * 0.5),
    });
  }
  return out;
}

/** The words inside a balloon or panel. */
function drawShapeWords(ctx, L, w, h, W) {
  const text = L.text;
  if (!text) return;
  const px = Math.max(4, w * clamp(L.textSize == null ? 0.13 : L.textSize, 0.02, 0.6));
  ctx.save();
  ctx.font = textLayerFont({ font: L.font || 'sans', weight: L.weight || 700 }, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Inside the rim, not on it. A balloon's words have to clear the curve, so
  // the box they wrap into is a good deal smaller than the balloon.
  const inset = (L.shape === 'caption' || L.shape === 'banner') ? 0.86
              : L.shape === 'burst' ? 0.56 : 0.68;
  const lines = wrapLines(ctx, text, w * inset);
  const lineH = px * 1.2;
  const y0 = -(lines.length - 1) * lineH / 2;
  ctx.fillStyle = L.textColor || '#101418';
  lines.forEach((s, i) => ctx.fillText(s, 0, y0 + i * lineH));
  ctx.restore();
}

function drawShapeLayer(ctx, L, W, H) {
  const b = layerBox(L, W, H);
  ctx.save();
  ctx.translate(b.cx, b.cy);
  ctx.rotate(b.rot);
  const w = b.w, h = b.h;
  const lw = Math.max(1, W * (L.strokeW || 0));
  shapePath(ctx, L, w, h);
  if (L.fill && L.fill !== 'none') { ctx.fillStyle = L.fill; ctx.fill(); }
  if (L.stroke && L.strokeW > 0) {
    ctx.strokeStyle = L.stroke;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    // A whisper is drawn with a broken line. It is the convention, and it is
    // the only difference from a speech balloon that still reads at the size
    // a balloon is actually used at.
    if (L.shape === 'whisper') ctx.setLineDash([lw * 3.4, lw * 2.6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (L.shape === 'thought') {
    thoughtTrail(L, w, h).forEach(c => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      if (L.fill && L.fill !== 'none') { ctx.fillStyle = L.fill; ctx.fill(); }
      if (L.stroke && L.strokeW > 0) { ctx.strokeStyle = L.stroke; ctx.lineWidth = lw; ctx.stroke(); }
    });
  }
  if (L.shape === 'caption' && L.stroke && L.strokeW > 0) {
    // A narration box is ruled twice: the outer edge and a thin line inside it.
    const g = Math.min(w, h) * 0.055;
    ctx.beginPath();
    roundRect(ctx, -w / 2 + g, -h / 2 + g, w - g * 2, h - g * 2, 0);
    ctx.lineWidth = Math.max(1, lw * 0.5);
    ctx.stroke();
  }
  if (shapeHoldsWords(L)) drawShapeWords(ctx, L, w, h, W);
  ctx.restore();
}

/* ---- animated pictures -------------------------------------------------------

   A layer can be an animated GIF or an animated PNG, and the frames are decoded
   HERE rather than left to the browser.

   The obvious thing — point an <img> at the file and let it animate — does not
   work, and it is worth saying why so nobody tries it again. `drawImage` from
   an <img> copies whatever frame that element happens to be showing; a detached
   Image is not in the document, so in several browsers it never advances at
   all, and where it does advance it does so on wall-clock time. That makes the
   picture a function of when you looked rather than of which frame you are on,
   which breaks the one rule every other moving part of this app keeps: the
   preview and the export agree, and exporting twice gives the same file.

   So both formats are parsed, every frame is composed to full size, and the
   frame for a given moment is worked out from the clip's own frame index.

   `ImageDecoder` would do most of this in three lines where it exists. It is
   not in Firefox, and a second code path that only some people ever run is a
   second set of bugs that only some people ever see.
--------------------------------------------------------------------------- */

/** How much decoded animation one layer may hold. Frames are composed to full
    size, so they cost w × h × 4 each: a 600×600 GIF is 1.4MB a frame and a
    long one will take a tab down. */
const ANIM_MAX_FRAMES = 300;
const ANIM_MAX_PIXELS = 420 * 1024 * 1024 / 4;    // ~420MB of composed frames

const u16 = (d, i) => d[i] | (d[i + 1] << 8);          // GIF is little-endian
const be16 = (d, i) => (d[i] << 8) | d[i + 1];         // PNG is big-endian
const be32 = (d, i) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;

function animKind(bytes) {
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (bytes.length > 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  return null;
}

/** GIF's LZW, unpacked. The encoder in this file has the other half of this;
    they are deliberately not shared, because a decoder that reuses the
    encoder's tables is a decoder that agrees with our own bugs. */
function lzwDecode(data, minCodeSize, expected) {
  const out = new Uint8Array(expected);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  // 4096 entries, each a (prefix, suffix) pair — a linked list, not a growing
  // array of arrays, which is what keeps a long frame from allocating madly.
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let size = minCodeSize + 1, next = eoi + 1, prev = -1;
  let bits = 0, nbits = 0, at = 0, got = 0;
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }
  while (at < data.length && got < expected) {
    bits |= data[at++] << nbits;
    nbits += 8;
    while (nbits >= size && got < expected) {
      const code = bits & ((1 << size) - 1);
      bits >>= size; nbits -= size;
      if (code === eoi) { nbits = 0; at = data.length; break; }
      if (code === clear) { size = minCodeSize + 1; next = eoi + 1; prev = -1; continue; }
      let cur = code, top = 0;
      if (code === next && prev >= 0) {
        // The one case that trips every naive implementation: a code that has
        // not been defined yet, which is legal and means "the previous string
        // plus its own first byte".
        let w = prev;
        while (w >= 0) { stack[top++] = suffix[w]; w = prefix[w]; }
        const first = stack[top - 1];
        for (let i = top - 1; i >= 0; i--) { if (got < expected) out[got++] = stack[i]; }
        if (got < expected) out[got++] = first;
      } else {
        if (cur > next) { at = data.length; break; }   // corrupt: stop cleanly
        while (cur >= 0) { stack[top++] = suffix[cur]; cur = prefix[cur]; }
        for (let i = top - 1; i >= 0; i--) { if (got < expected) out[got++] = stack[i]; }
      }
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev;
        // The new entry's suffix is the FIRST byte of the string just emitted.
        let w = code === next ? prev : code, f = w;
        while (prefix[f] >= 0) f = prefix[f];
        suffix[next] = suffix[f];
        next++;
        if (next === (1 << size) && size < 12) size++;
      }
      prev = code;
    }
  }
  return out;
}

/** Every frame of an animated GIF, composed to the full canvas. */
async function decodeGif(bytes) {
  const d = bytes;
  let at = 6;                                        // past GIF87a / GIF89a
  const W = u16(d, at), H = u16(d, at + 2);
  const packed = d[at + 4];
  at += 7;
  let gct = null;
  if (packed & 0x80) {
    const n = 2 << (packed & 7);
    gct = d.subarray(at, at + n * 3);
    at += n * 3;
  }
  if (!W || !H || W * H > ANIM_MAX_PIXELS) throw new Error('that GIF is too large to animate');

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let loops = 0;                                     // 0 = forever, GIF's own default
  let delay = 10, transparent = -1, dispose = 0;

  const subBlocks = () => {
    const parts = [];
    let n;
    while (at < d.length && (n = d[at++]) !== 0) { parts.push(d.subarray(at, at + n)); at += n; }
    let len = 0; parts.forEach(p => { len += p.length; });
    const all = new Uint8Array(len);
    let o = 0; parts.forEach(p => { all.set(p, o); o += p.length; });
    return all;
  };

  while (at < d.length) {
    const b = d[at++];
    if (b === 0x3B) break;                           // trailer
    if (b === 0x21) {                                // extension
      const label = d[at++];
      if (label === 0xF9) {
        const n = d[at++];
        const p = d[at];
        dispose = (p >> 2) & 7;
        transparent = (p & 1) ? d[at + 3] : -1;
        delay = u16(d, at + 1) || 10;                // 0 means "as fast as you like"
        at += n + 1;                                 // + the block terminator
      } else if (label === 0xFF) {
        const n = d[at];
        const name = String.fromCharCode(...d.subarray(at + 1, at + 12));
        at += n + 1;
        const body = subBlocks();
        if (/^NETSCAPE/.test(name) && body.length >= 3 && body[0] === 1) loops = u16(body, 1);
      } else { at++; subBlocks(); }
      continue;
    }
    if (b !== 0x2C) break;                           // not an image: give up cleanly
    const fx = u16(d, at), fy = u16(d, at + 2);
    const fw = u16(d, at + 4), fh = u16(d, at + 6);
    const ip = d[at + 8];
    at += 9;
    let table = gct;
    if (ip & 0x80) { const n = 2 << (ip & 7); table = d.subarray(at, at + n * 3); at += n * 3; }
    const interlaced = !!(ip & 0x40);
    const minCode = d[at++];
    const data = subBlocks();
    if (!table || !fw || !fh) continue;

    const idx = lzwDecode(data, minCode, fw * fh);
    const im = ctx.createImageData(fw, fh);
    const px = im.data;
    // Interlaced GIFs arrive in four passes. Rare now, and exactly the thing
    // that silently produces a venetian-blind picture if it is ignored.
    const rowOf = interlaced ? interlaceRows(fh) : null;
    for (let y = 0; y < fh; y++) {
      const sy = rowOf ? rowOf[y] : y;
      for (let x = 0; x < fw; x++) {
        const c = idx[y * fw + x];
        const o = (sy * fw + x) * 4;
        if (c === transparent) { px[o + 3] = 0; continue; }
        px[o] = table[c * 3]; px[o + 1] = table[c * 3 + 1]; px[o + 2] = table[c * 3 + 2];
        px[o + 3] = 255;
      }
    }
    const before = dispose === 3 ? ctx.getImageData(0, 0, W, H) : null;
    // A frame REPLACES its rectangle where it is opaque and leaves it where it
    // is transparent, which is putImageData's behaviour only if the rectangle
    // was cleared first — so the patch goes through a scratch canvas and is
    // drawn, not poked.
    const patch = document.createElement('canvas');
    patch.width = fw; patch.height = fh;
    patch.getContext('2d').putImageData(im, 0, 0);
    ctx.drawImage(patch, fx, fy);

    const shot = document.createElement('canvas');
    shot.width = W; shot.height = H;
    shot.getContext('2d').drawImage(cv, 0, 0);
    frames.push({ canvas: shot, delay: delay / 100 });
    if (frames.length >= ANIM_MAX_FRAMES) break;

    if (dispose === 2) ctx.clearRect(fx, fy, fw, fh);
    else if (dispose === 3 && before) ctx.putImageData(before, 0, 0);
    delay = 10; transparent = -1; dispose = 0;
  }
  return frames.length > 1 ? { frames, w: W, h: H, loops } : null;
}

/** The row each stored line belongs to, for an interlaced GIF. */
function interlaceRows(h) {
  const rows = new Int32Array(h);
  let k = 0;
  [[0, 8], [4, 8], [2, 4], [1, 2]].forEach(([start, step]) => {
    for (let y = start; y < h; y += step) rows[k++] = y;
  });
  return rows;
}

/** One PNG chunk, ready to concatenate. */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Every frame of an APNG, composed to the full canvas.

    Each frame is rebuilt as a complete one-frame PNG and handed to
    createImageBitmap, so the browser does the actual pixel decoding — which is
    the part worth not writing by hand. What is written here is the container:
    which chunks belong to which frame, and how each frame is laid over the
    last. */
async function decodeApng(bytes) {
  const d = bytes;
  let at = 8;
  let ihdr = null, extras = [], acTL = null;
  const raw = [];                   // {fctl, parts:[Uint8Array]}
  let cur = null, sawIdat = false;
  while (at + 8 <= d.length) {
    const len = be32(d, at);
    const type = String.fromCharCode(d[at + 4], d[at + 5], d[at + 6], d[at + 7]);
    const body = d.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'acTL') acTL = { count: be32(body, 0), plays: be32(body, 4) };
    else if (type === 'fcTL') {
      cur = {
        w: be32(body, 4), h: be32(body, 8), x: be32(body, 12), y: be32(body, 16),
        num: be16(body, 20), den: be16(body, 22) || 100,
        dispose: body[24], blend: body[25], parts: []
      };
      raw.push(cur);
    } else if (type === 'IDAT') {
      sawIdat = true;
      // An IDAT after an fcTL IS the first frame; before one, it is the still
      // picture that non-animating viewers show and no frame of the animation.
      if (cur && !cur.parts.length && raw.length === 1) cur.parts.push(body);
      else if (!raw.length) extras.push({ type, body });
    } else if (type === 'fdAT') {
      if (cur) cur.parts.push(body.subarray(4));     // past the sequence number
    } else if (type === 'IEND') break;
    else if (!sawIdat && type !== 'acTL') extras.push({ type, body });
    at += 12 + len;
  }
  if (!acTL || !ihdr || raw.length < 2) return null;

  const W = be32(ihdr, 0), H = be32(ihdr, 4);
  if (!W || !H || W * H > ANIM_MAX_PIXELS) throw new Error('that PNG is too large to animate');

  const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // PLTE, tRNS, gAMA and friends belong to every frame, so they are carried
  // into each rebuilt one. A palette PNG without its PLTE decodes as nothing.
  const carried = extras.filter(e => !/^(IDAT|IEND|acTL|fcTL|fdAT)$/.test(e.type))
                        .map(e => pngChunk(e.type, e.body));

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < raw.length && frames.length < ANIM_MAX_FRAMES; i++) {
    const f = raw[i];
    if (!f.parts.length) continue;
    const head = new Uint8Array(ihdr);
    new DataView(head.buffer).setUint32(0, f.w);
    new DataView(head.buffer).setUint32(4, f.h);
    const pieces = [sig, pngChunk('IHDR', head), ...carried];
    f.parts.forEach(p => pieces.push(pngChunk('IDAT', p)));
    pieces.push(pngChunk('IEND', new Uint8Array(0)));
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob(pieces, { type: 'image/png' }));
    } catch (e) { continue; }                        // a frame that will not decode is skipped
    const before = f.dispose === 2 ? ctx.getImageData(0, 0, W, H) : null;
    if (f.blend === 0) ctx.clearRect(f.x, f.y, f.w, f.h);   // SOURCE replaces
    ctx.drawImage(bmp, f.x, f.y);
    bmp.close && bmp.close();
    const shot = document.createElement('canvas');
    shot.width = W; shot.height = H;
    shot.getContext('2d').drawImage(cv, 0, 0);
    frames.push({ canvas: shot, delay: (f.num || 1) / f.den });
    if (f.dispose === 1) ctx.clearRect(f.x, f.y, f.w, f.h);
    else if (f.dispose === 2 && before) ctx.putImageData(before, 0, 0);
  }
  return frames.length > 1 ? { frames, w: W, h: H, loops: acTL.plays } : null;
}

/** Decode a file's animation, or null if it has none. Never throws for "this
    is just a still" — only for "this is animated and too big to hold". */
async function decodeAnimation(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = animKind(bytes);
  if (!kind) return null;
  const a = kind === 'gif' ? await decodeGif(bytes) : await decodeApng(bytes);
  if (!a) return null;
  a.total = a.frames.reduce((n, f) => n + Math.max(0.01, f.delay), 0);
  return a;
}

/* ---- playing one ---------------------------------------------------------- */

const ANIM_LOOPS = [
  ['loop', 'Repeat'],
  ['once', 'Play once, then hold'],
  ['boomerang', 'Back and forth'],
];

/** Which frame of an animated layer belongs at clip frame `frame`.

    Worked from the frame INDEX, not from a clock. That is what makes the
    preview and the export the same picture, and a scrub backwards show what
    the scrub forwards showed. */
function animFrameAt(L, frame) {
  const a = L.anim;
  if (!a || !a.frames.length) return null;
  const fps = state.fps || 12;
  const speed = Math.max(0.05, L.animSpeed == null ? 1 : L.animSpeed);
  const t = Math.max(0, (frame || 0) / fps - (L.animStart || 0)) * speed;
  const total = a.total;
  let u = t;
  const mode = L.animLoop || 'loop';
  if (mode === 'once') {
    if (u >= total) return a.frames[a.frames.length - 1].canvas;
  } else if (mode === 'boomerang') {
    const cycle = total * 2;
    u = u % cycle;
    if (u > total) u = cycle - u;                    // and back again
  } else {
    u = u % total;
  }
  let acc = 0;
  for (let i = 0; i < a.frames.length; i++) {
    acc += Math.max(0.01, a.frames[i].delay);
    if (u < acc) return a.frames[i].canvas;
  }
  return a.frames[a.frames.length - 1].canvas;
}

function drawImageLayer(ctx, L, W, H, frame) {
  const src = L.anim ? animFrameAt(L, frame) : L.img;
  if (!src) return;
  const b = layerBox(L, W, H);
  ctx.save();
  ctx.translate(b.cx, b.cy);
  ctx.rotate(b.rot);
  if (L.mirror) ctx.scale(-1, 1);
  ctx.drawImage(src, -b.w / 2, -b.h / 2, b.w, b.h);
  ctx.restore();
}

/* ---- several characters on screen ------------------------------------------

   A conversation is not a series of cutaways unless you want it to be. Two
   people can sit on screen together, both drawn, with the mouth moving on
   whichever of them is talking and the other's resting shut. That is what a
   two-shot looks like, and it needs three things this did not have.

   **A mouth spot per character.** Where the mouth belongs on THAT face, held
   in the character's own box coordinates rather than the frame's. Move or
   resize the character and the mouth goes with it, because it is described
   relative to them. (This is the layer parenting flagged when the layer system
   was first built and deliberately not done then; a two-shot is what finally
   earned it.)

   **Turns.** The split points already divide the take into stretches and are
   already draggable and already found by "Find the pauses". Using them to say
   WHO IS TALKING, without cutting the clip up, turns a mark-up people already
   do into the whole feature.

   **One mouth is still enough**, because only one person speaks at a time. The
   mouth layer draws once per character with a spot: the speaker's gets the
   frame's viseme, everyone else gets X. No second set of keyframes, no second
   blur patch, nothing new threaded through the sixty-odd places the mouth
   already reaches.
--------------------------------------------------------------------------- */

/** Characters: any layer that can carry a face. */
const canHoldMouth = L => !!L && (L.kind === 'image' || L.kind === 'plate');
const mouthSpotLayers = () => layers.filter(L => canHoldMouth(L) && L.mouthSpot);

/** Where a layer's mouth sits, in frame pixels.

    The spot is stored as fractions of the LAYER's own box — x and y across it,
    size as a share of its width — so it survives the character being moved,
    scaled, turned or reflowed by a canvas change. */
function mouthSpotBox(L, W, H) {
  const sp = L && L.mouthSpot;
  if (!sp) return null;
  const b = boxForLayer(L, W, H);
  const bw = b.w != null ? b.w : b.s;
  const bh = b.h != null ? b.h : b.s;
  // The offset from the layer's centre, in the layer's own unrotated frame,
  // then turned by the layer's rotation so a tilted head keeps its mouth.
  const ox = (sp.x - 0.5) * bw, oy = (sp.y - 0.5) * bh;
  const c = Math.cos(b.rot), sn = Math.sin(b.rot);
  const s = sp.size * bw;
  return {
    s, cx: b.cx + ox * c - oy * sn, cy: b.cy + ox * sn + oy * c,
    rot: b.rot + (sp.rot || 0) * Math.PI / 180,
    x: b.cx + ox * c - oy * sn - s / 2, y: b.cy + ox * sn + oy * c - s / 2,
  };
}

/** Turn a frame-space mouth placement into a spot on this layer. */
function spotFromOverlay(L, W, H, p) {
  const b = boxForLayer(L, W, H);
  const bw = b.w != null ? b.w : b.s;
  const bh = b.h != null ? b.h : b.s;
  if (!bw || !bh) return null;
  const dx = p.x * W - b.cx, dy = p.y * H - b.cy;
  const c = Math.cos(-b.rot), sn = Math.sin(-b.rot);
  return {
    x: (dx * c - dy * sn) / bw + 0.5,
    y: (dx * sn + dy * c) / bh + 0.5,
    size: (p.size * W) / bw,
    rot: normDeg((p.rot || 0) - b.rot * 180 / Math.PI),
  };
}

/* ---- turns ---------------------------------------------------------------- */

/** The stretches the split points divide this clip into, in CLIP seconds —
    which is what a frame number maps to, and not what the marks are stored in. */
function turnStretches(clip) {
  if (!clip) return [];
  const dur = keptDuration(clip) || (state.buffer ? state.buffer.duration : 0);
  if (!dur) return [];
  const a = clip.in || 0, b = clip.out == null ? (clip.srcDuration || 0) : clip.out;
  const cuts = (clip.marks || [])
    .filter(m => m > a && m < b)
    .map(m => srcToClip(clip, m))
    .filter(t => t > 0.02 && t < dur - 0.02)
    .sort((x, y) => x - y);
  const edges = [0, ...cuts, dur];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) out.push({ from: edges[i], to: edges[i + 1] });
  return out;
}

/** Keep the speaker assignments across a change to the split points.

    Matched by OVERLAP, not by index: drop a new mark in the middle and every
    stretch after it shifts along by one, so an index-based carry would hand
    every line to the wrong person. */
function rebuildTurns(clip) {
  if (!clip) return [];
  const old = clip.turns || [];
  const next = turnStretches(clip).map(st => {
    let best = null, bestOver = 0;
    old.forEach(o => {
      const over = Math.min(st.to, o.to) - Math.max(st.from, o.from);
      if (over > bestOver) { bestOver = over; best = o; }
    });
    return { from: st.from, to: st.to, layerId: best ? best.layerId : null };
  });
  clip.turns = next;
  return next;
}

/** Who is talking at this clip time. */
function speakerAt(t) {
  const c = activeClip();
  const turns = (c && c.turns) || [];
  for (const tn of turns) {
    if (t >= tn.from && t < tn.to) return tn.layerId ? layerById(tn.layerId) : null;
  }
  // No turns set: with exactly one character pinned, they are obviously the
  // one talking, and asking people to fill in a one-row table to be told that
  // would be a form for its own sake.
  const m = mouthSpotLayers();
  return m.length === 1 ? m[0] : null;
}

/* ---- when a layer is on screen -------------------------------------------- */

/** A layer with no range is on for the whole clip, which is every layer until
    someone says otherwise. */
function layerLiveAt(L, t) {
  if (!L) return false;
  if (L.from != null && t < L.from) return false;
  if (L.to != null && t > L.to) return false;
  return true;
}

/** Which stretch a frame falls in, or -1. */
let turnsShownRow = -1;
function turnsRowAt(frame) {
  const c = activeClip();
  const turns = (c && c.turns) || [];
  const t = frame / Math.max(1, state.fps || 12);
  return turns.findIndex(tn => t >= tn.from && t < tn.to);
}

/** Keep the mouth above every character it is pinned to.

    A mouth under an opaque drawing is an invisible mouth, and the mouth layer
    starts at the bottom of the stack — so pinning it to a face that was added
    later drew the face straight over it. Caught by a harness counting pixels
    per character and finding nothing ever changed.

    Moving it is better than drawing it last: the list goes on meaning what it
    says, and a caption deliberately placed above the mouth stays above it. */
function liftMouthOverFaces() {
  const m = mouthLayer();
  const pinned = mouthSpotLayers();
  if (!m || !pinned.length) return false;
  const top = Math.max(...pinned.map(L => layers.indexOf(L)));
  const at = layers.indexOf(m);
  if (at > top) return false;
  layers.splice(at, 1);
  layers.splice(layers.indexOf(pinned.reduce((a, b) =>
    layers.indexOf(a) > layers.indexOf(b) ? a : b)) + 1, 0, m);
  return true;
}

/** The turns panel: one row per stretch, with who is talking on it. */
function renderTurns() {
  const wrap = $('turnsWrap');
  if (!wrap) return;
  const pinned = mouthSpotLayers();
  const c = activeClip();
  // Nobody to choose between until two characters have mouths on them.
  wrap.hidden = pinned.length < 2 || !c || !state.frames.length;
  if (wrap.hidden) return;
  const turns = rebuildTurns(c);
  const here = currentFrameIndex() / Math.max(1, state.fps || 12);
  const list = $('turnsList');
  list.innerHTML = '';
  turns.forEach((tn, i) => {
    const row = document.createElement('div');
    row.className = 'trow' + (here >= tn.from && here < tn.to ? ' now' : '');
    const n = document.createElement('span');
    n.className = 'tnum';
    n.textContent = String(i + 1);
    const t = document.createElement('span');
    t.className = 'ttime';
    t.textContent = fmtTime(tn.from) + ' → ' + fmtTime(tn.to);
    const face = document.createElement('span');
    face.className = 'tface';
    const who = tn.layerId && layerById(tn.layerId);
    if (who) face.appendChild(layerThumb(who));
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'nobody';
    sel.appendChild(none);
    pinned.forEach(L => {
      const o = document.createElement('option');
      o.value = L.id;
      o.textContent = L.name || LAYER_KIND_LABEL[L.kind] || 'Layer';
      sel.appendChild(o);
    });
    sel.value = tn.layerId && pinned.some(L => L.id === tn.layerId) ? tn.layerId : '';
    sel.onchange = () => {
      tn.layerId = sel.value || null;
      bankLayers();
      renderTurns();
      drawStage();
    };
    row.append(n, t, face, sel);
    list.appendChild(row);
  });
  const note = $('turnsNote');
  if (note) {
    const named = turns.filter(t => t.layerId).length;
    note.textContent = turns.length === 1
      ? 'One stretch — put split points in on the waveform to divide the take into turns.'
      : turns.length + ' stretches from the split points · ' + named + ' with a speaker' +
        '. Move a split point and these follow it.';
  }
}

/** Hand the stretches out alternately between whoever has a mouth on them.
    A head start, not a decision: every row is a picker. */
function seedTurns(c) {
  if (!c) return;
  const pinned = mouthSpotLayers();
  const turns = rebuildTurns(c);
  if (pinned.length < 2 || turns.some(t => t.layerId)) return;
  turns.forEach((t, i) => { t.layerId = pinned[i % pinned.length].id; });
}

/** What a layer's picture depends on, as a string. Anything NOT in here is a
    change the boil cache will miss — and anything in here that changes every
    frame defeats the cache entirely, which is why the pose is rounded rather
    than taken raw. */
const poseKey = p => p ? [p.x, p.y, p.size, p.rot].map(n => (+n).toFixed(3)).join(',') : '';

function layerContentKey(L, frame) {
  const base = L.kind + '|' + poseKey(L.pose) + '|' + (L.mirror ? 1 : 0);
  if (L.kind === 'image') {
    // An animated layer is a different picture on most frames, so its own
    // frame number has to be in the key or every drawing would be the first.
    let a = '';
    if (L.anim) {
      const c = animFrameAt(L, frame);
      a = String(L.anim.frames.findIndex(f => f.canvas === c));
    }
    return base + '|' + (L.name || '') + '|' + a;
  }
  if (L.kind === 'text') {
    return base + '|' + (L.text || '') + '|' + L.color + '|' + L.stroke + '|' +
           L.strokeW + '|' + L.font + '|' + L.weight;
  }
  return base + '|' + L.shape + '|' + L.fill + '|' + L.stroke + '|' +
         L.strokeW + '|' + L.ar + '|' + L.radius;
}

/** One layer that is not the plate and not the mouth. */
function drawExtraLayer(ctx, L, W, H, frame, noFx) {
  if (!L.visible) return;
  ctx.save();
  if (L.opacity != null && L.opacity < 1) ctx.globalAlpha = clamp(L.opacity, 0, 1);
  if (!noFx) applyLayerShadow(ctx, L, W);
  (noFx ? (c, l, w, h, f, fn) => fn(c) : withBoil)(ctx, L, W, H, frame, c2 => {
    if (L.kind === 'image') drawImageLayer(c2, L, W, H, frame);
    else if (L.kind === 'text') drawTextLayer(c2, L, W, H);
    else if (L.kind === 'shape') drawShapeLayer(c2, L, W, H);
  }, layerContentKey(L, frame));
  ctx.restore();
}


/* ---- line boil -------------------------------------------------------------

   The wobble a drawing has when it is drawn again for every frame. Traditional
   animation has it because a human redrew the line; vector animation has to put
   it back on purpose, and without it a mouth cut onto hand-drawn artwork sits
   on the page like a sticker — perfectly still while everything around it
   breathes.

   It is a tiny shift and a tiny turn, changed every so many frames. Two things
   make it usable rather than a gimmick:

   - It is DETERMINISTIC. The offset is a hash of the layer and the step number,
     not a random draw, so the preview and the export agree frame for frame and
     exporting the same clip twice gives the same file. Random here would mean
     a scrub backwards showed a different picture than the way down.
   - It HOLDS. Real boil is on twos or threes — the drawing changes every second
     or third frame, not every frame — and at 24fps a per-frame jitter reads as
     noise rather than as drawing. `rate` is that hold.
--------------------------------------------------------------------------- */
/* 0.004 of the frame — about one pixel on a preview — was the default, and at
   that size ticking the box changed nothing anybody could see. Real boil is a
   line redrawn by hand, and a hand misses by more than a pixel. 0.012 is a
   visible wobble that still reads as the same drawing. 0.012 was still being
   reported as invisible, hence 0.016 — and the Try it button, because the real
   problem was never the amount: it was that you cannot see a per-frame effect
   on a frame that is not moving. */
const BOIL_DEFAULT = {
  effect: 'jitter',  // which of the six
  intensity: 1,      // 1-12, how far the line wanders. One is the gentlest
                     // setting there is, and the one a drawn line actually
                     // wants: enough to breathe, not enough to read as shake.
  grain: 6,          // 1-10, how big each wobble is — the noise's scale
  smooth: false,     // bilinear sampling: softer, slower
  count: 3,          // how many drawings cycle
  fps: 12,           // the cycle's own frame rate
  pingpong: true,    // and back again, so the loop has no jump
  edges: 0,          // 0 = the whole picture warps, 100 = only near the lines
  seed: 1,
};

/** Is boil on anywhere, and on everything? The row's switch is "on for every
    layer", so it needs both answers. */
function boilLayerCount() {
  const able = layers.filter(L => L.kind !== 'mouth' || true);
  const on = able.filter(L => L.boil === true).length;
  return { on, all: able.length };
}
const boilAnyOn = () => layers.some(L => L.boil === true);

/** Is every frame its own picture, or are there only nine shapes repeated?

    Several exports lean on this. A still puppet with no keyframed move draws
    the same picture for the same mouth shape, so the GIF can cache one picture
    per shape, the animated PNG can emit a held frame instead of a new one, and
    the sprite sheet can pack nine cells instead of one per frame. All of that
    is a big saving and all of it is correct — until the LINE BOIL is on, when
    the whole point is that the drawing changes every few frames. Each of those
    three worked this out for itself from the plate and the keyframes, and none
    of them had been told the boil exists, so a boiled export quietly came out
    unboiled.

    One function now, so the next thing that makes a frame unique has one place
    to say so. */
function everyFrameDiffers() {
  return puppet.kind !== 'image' || boilAnyOn();
}

/** Turn it on or off across the stack. */
function boilSetAll(on) {
  layers.forEach(L => { L.boil = !!on; });
  bankLayers();
  syncBoilUI();
  renderLayerPanel();
  drawStage();
}
const boil = { ...BOIL_DEFAULT };

/** A stable pseudo-random triple for one layer at one step. Integer hashing
    rather than Math.random for the reason above. */
function boilAt(seed, step) {
  let h = (seed * 2654435761 ^ (step + 1) * 40503) >>> 0;
  const nxt = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296 * 2 - 1;
  };
  return { dx: nxt(), dy: nxt(), rot: nxt() };
}

/* ---- line boil ---------------------------------------------------------------

   Modelled on the Line Boil Generator, which does the real thing: a per-pixel
   displacement by value noise, in a SET OF DRAWINGS that cycle.

   What was here before translated and rotated the whole layer by a few pixels.
   That is one of the six effects below — "drift", registration wobble, the
   paper shifting on the pegs — and it is the only one of the six that leaves a
   line exactly as it was drawn. Every other kind of boil moves parts of the
   drawing by different amounts, which is the thing a hand does and a transform
   cannot.

   Three properties are worth keeping:

   - **A set of drawings, cycled.** Not a new offset every frame. Two to twelve
     drawings shown in turn, optionally back and forth, is what the eye reads
     as "someone drew this a few times".
   - **Pre-rendered.** A per-pixel warp of a full frame is far too slow to do
     every frame. Each drawing is made once and cached; playback is a cache
     lookup. This is also why the drawing count matters more than it looks —
     it is the number of warps, not a style preference.
   - **Deterministic.** Value noise seeded from the layer, the drawing number
     and the seed — never Math.random, except in "tremble", where the grit is
     the point and the frames are cached anyway so it still never changes
     between the preview and the export.
--------------------------------------------------------------------------- */

const BOIL_EFFECTS = [
  ['jitter',  'Jitter',  'Fine, even shimmer over the whole drawing — the classic boil.'],
  ['warp',    'Warp',    'Broad taffy pull. Whole limbs breathe in and out of shape.'],
  ['ripple',  'Ripple',  'Concentric waves from the centre, like heat off a road.'],
  ['tremble', 'Tremble', 'Noise plus grit. Rough, nervous, hand-inked-at-2am.'],
  ['swell',   'Swell',   'A slow breathing pulse in scale, with a light shimmer on top.'],
  ['drift',   'Drift',   'Registration wobble — the paper shifts on the pegs, lines stay clean.'],
];

function boilHashNoise(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  h = h ^ (h >>> 16);
  return ((h & 0x7fffffff) / 0x3fffffff) - 1;
}
function boilSmoothNoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = boilHashNoise(xi, yi, s),     b = boilHashNoise(xi + 1, yi, s);
  const c = boilHashNoise(xi, yi + 1, s), d = boilHashNoise(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u;
  return ab + ((c + (d - c) * u) - ab) * v;
}
function boilFbm(x, y, s, oct) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * boilSmoothNoise(x * freq, y * freq, s + i * 131);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
const boilAmplitude = (intensity, w, h) =>
  intensity * 1.35 * clamp(0.6 + Math.min(w, h) / 700, 0.55, 2.2);
const boilFrequency = grain => 0.0035 + 0.0042 * grain;

/** Which drawing belongs at this clip frame, honouring the cycle's own frame
    rate and the ping-pong. */
function boilDrawingAt(frame) {
  const n = clamp(Math.round(boil.count), 1, 12);
  if (n < 2) return 0;
  const seq = [];
  for (let i = 0; i < n; i++) seq.push(i);
  // Back and forth without repeating the ends, so the turn does not stutter.
  if (boil.pingpong && n > 2) for (let i = n - 2; i >= 1; i--) seq.push(i);
  const t = Math.max(0, frame || 0) / Math.max(1, state.fps || 12);
  const k = Math.floor(t * clamp(boil.fps, 1, 30));
  return seq[((k % seq.length) + seq.length) % seq.length];
}

/** Warp one canvas into another. `src` and `dst` are the same size — the
    layer is drawn into a frame-sized scratch, so there is nowhere for it to
    overflow to and no padding to manage. */
function boilDisplaceInto(dst, src, L, drawing) {
  const w = src.width, h = src.height;
  const effect = boil.effect || 'jitter';
  const intensity = clamp(boil.intensity, 1, 12);
  const seed = boilSeedOf(L) + drawing * 3733.7;

  if (effect === 'drift') {
    // The affine one. Line quality stays pristine because nothing is
    // resampled per pixel — it is the whole sheet moving.
    const amp = boilAmplitude(intensity, w, h);
    const dx = boilHashNoise(1, 7, seed | 0) * amp * 1.25;
    const dy = boilHashNoise(5, 3, (seed | 0) + 91) * amp * 1.25;
    const rot = boilHashNoise(9, 11, (seed | 0) + 401) * intensity * 0.0022;
    const sc = 1 + boilHashNoise(13, 2, (seed | 0) + 777) * intensity * 0.0016;
    const x = dst.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, w, h);
    x.save();
    x.translate(w / 2 + dx, h / 2 + dy);
    x.rotate(rot);
    x.scale(sc, sc);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, -w / 2, -h / 2);
    x.restore();
    return;
  }

  const sctx = src.getContext('2d', { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, w, h).data;
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  const od = dctx.createImageData(w, h);
  const out = od.data;

  const amp = boilAmplitude(intensity, w, h);
  const f = boilFrequency(clamp(boil.grain, 1, 10));
  const cx = w / 2, cy = h / 2;
  const s2 = seed + 4127;
  const smooth = !!boil.smooth;
  // How much the displacement is pulled towards the lines. Not in the app
  // this is modelled on; kept because a boiling background with a still
  // outline is a thing people ask for, and 0 gives exactly its behaviour.
  const bias = clamp(boil.edges / 100, 0, 1);
  const cols = 24, rows = 24;
  const edge = bias > 0 ? boilEdgeMap(src, cols, rows) : null;

  for (let y = 0; y < h; y++) {
    for (let px = 0; px < w; px++) {
      let sx = px, sy = y;
      let k = 1;
      if (edge) {
        const gx = Math.min(cols, (px / w * cols) | 0);
        const gy = Math.min(rows, (y / h * rows) | 0);
        k = (1 - bias) + bias * edge[gy * (cols + 1) + gx];
      }
      const a2 = amp * k;
      if (effect === 'jitter') {
        sx += boilFbm(px * f, y * f, seed, 3) * a2;
        sy += boilFbm(px * f, y * f, s2, 3) * a2;
      } else if (effect === 'warp') {
        const g = f * 0.42;
        sx += boilFbm(px * g + 3.1, y * g + 1.7, seed, 2) * a2 * 2.4;
        sy += boilFbm(px * g + 8.3, y * g + 5.9, s2, 2) * a2 * 2.4;
      } else if (effect === 'ripple') {
        const d = Math.hypot(px - cx, y - cy);
        const ph = d * f * 5 + seed * 0.37;
        sx += Math.cos(ph) * a2 * 1.35;
        sy += Math.sin(ph) * a2 * 1.35;
      } else if (effect === 'tremble') {
        sx += boilSmoothNoise(px * f * 2.1, y * f * 2.1, seed) * a2
            + (boilHashNoise(px, y, seed | 0)) * intensity * 0.25 * k;
        sy += boilSmoothNoise(px * f * 2.1, y * f * 2.1, s2) * a2
            + (boilHashNoise(y, px, (seed | 0) + 17)) * intensity * 0.25 * k;
      } else if (effect === 'swell') {
        const pulse = 1 + boilHashNoise(3, 9, seed | 0) * intensity * 0.006;
        sx = cx + (px - cx) / pulse + boilFbm(px * f, y * f, seed, 2) * a2 * 0.5;
        sy = cy + (y - cy) / pulse + boilFbm(px * f, y * f, s2, 2) * a2 * 0.5;
      }

      const di = (y * w + px) * 4;
      if (smooth) {
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        let r = 0, g = 0, b = 0, a = 0;
        for (let q = 0; q < 4; q++) {
          const kx = x0 + (q & 1), ky = y0 + (q >> 1);
          const wgt = ((q & 1) ? fx : 1 - fx) * ((q >> 1) ? fy : 1 - fy);
          if (wgt === 0 || kx < 0 || ky < 0 || kx > w - 1 || ky > h - 1) continue;
          const si = (ky * w + kx) * 4;
          const al = sd[si + 3] / 255;
          r += sd[si] * al * wgt; g += sd[si + 1] * al * wgt; b += sd[si + 2] * al * wgt;
          a += sd[si + 3] * wgt;
        }
        if (a > 0.5) {
          // The colours were summed already multiplied by alpha, so they have
          // to be divided back out or every soft edge darkens towards black.
          const inv = 255 / a;
          out[di] = Math.min(255, r * inv);
          out[di + 1] = Math.min(255, g * inv);
          out[di + 2] = Math.min(255, b * inv);
          out[di + 3] = Math.min(255, a);
        }
      } else {
        const mx = Math.round(sx), my = Math.round(sy);
        if (mx < 0 || my < 0 || mx > w - 1 || my > h - 1) continue;
        const si = (my * w + mx) * 4;
        out[di] = sd[si]; out[di + 1] = sd[si + 1];
        out[di + 2] = sd[si + 2]; out[di + 3] = sd[si + 3];
      }
    }
  }
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.putImageData(od, 0, 0);
}

const boilSeedOf = L => {
  let h = 0;
  const s = (L && L.id ? L.id : 'x') + '|' + ((L && L.kind) || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h ^ Math.round((boil.seed || 1) * 7919)) | 0;
};

/* The edge map, read off a brutally downsampled copy of the layer: one pixel
   per cell. A point where its neighbours differ is on an outline; one in the
   middle of a flat fill is not. */
const boilTiny = { el: null, ctx: null };
function boilEdgeMap(src, cols, rows) {
  const w = cols + 1, h = rows + 1;
  if (!boilTiny.el) boilTiny.el = document.createElement('canvas');
  if (boilTiny.el.width !== w || boilTiny.el.height !== h) {
    boilTiny.el.width = w; boilTiny.el.height = h;
    boilTiny.ctx = boilTiny.el.getContext('2d', { willReadFrequently: true });
  }
  const t = boilTiny.ctx;
  t.setTransform(1, 0, 0, 1, 0, 0);
  t.clearRect(0, 0, w, h);
  t.drawImage(src, 0, 0, w, h);
  const d = t.getImageData(0, 0, w, h).data;
  const val = new Float32Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const a = d[o + 3] / 255;
    val[i] = a * (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255 + (1 - a) * -0.2;
  }
  const out = new Float32Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let m = 0;
      if (x > 0) m = Math.max(m, Math.abs(val[i] - val[i - 1]));
      if (x < w - 1) m = Math.max(m, Math.abs(val[i] - val[i + 1]));
      if (y > 0) m = Math.max(m, Math.abs(val[i] - val[i - w]));
      if (y < h - 1) m = Math.max(m, Math.abs(val[i] - val[i + w]));
      out[i] = m;
      if (m > max) max = m;
    }
  }
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

/* One scratch canvas for rendering a layer before it is warped. */
let boilSrcCanvas = null;
function boilSource(W, H) {
  if (!boilSrcCanvas) boilSrcCanvas = document.createElement('canvas');
  if (boilSrcCanvas.width !== W || boilSrcCanvas.height !== H) {
    boilSrcCanvas.width = W; boilSrcCanvas.height = H;
  }
  const c = boilSrcCanvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  return boilSrcCanvas;
}

/* ---- the edge of the paper -------------------------------------------------

   The warp samples the drawing at a displaced point, so a pixel at the very
   edge of the frame is told to fetch a pixel from just OUTSIDE it — where
   there is nothing, because the layer was drawn into a frame-sized scratch.
   Nothing reads as transparent, and on a layer that fills the frame — a
   background — that is a ragged bite out of all four sides with the page
   showing through it. White, on a starfield.

   A puppet never shows this: it has transparent air around it already, so
   fetching from outside fetches the same nothing that was there.

   The fix is the one the cameraman's answer has always been: give it some
   overscan. A full-bleed layer is blown up by just enough that the warp's
   whole reach lands on real picture, and the frame shows the middle of it.
   The cost is a couple of percent of scale on a background — invisible —
   and it is paid only by layers that actually reach the edge.
--------------------------------------------------------------------------- */

/** How far outside itself the warp can reach, in pixels, at these settings.
    Each effect displaces by its own multiple of the amplitude; `drift` moves
    the whole sheet instead, so its reach is the shift plus what the turn and
    the shrink expose at the corners. Generous on purpose: a fringe is far
    more noticeable than a hair more scale. */
function boilOverscan(W, H) {
  const i = clamp(boil.intensity, 1, 12);
  const amp = boilAmplitude(i, W, H);
  const half = Math.max(W, H) / 2;
  let d;
  switch (boil.effect || 'jitter') {
    case 'warp':    d = amp * 2.4; break;
    case 'ripple':  d = amp * 1.35; break;
    case 'tremble': d = amp + i * 0.25; break;
    case 'swell':   d = amp * 0.5 + half * (1 / Math.max(0.5, 1 - i * 0.006) - 1); break;
    case 'drift':   d = amp * 1.25 + Math.hypot(W, H) / 2 * i * 0.0022 + half * i * 0.0016;
                    break;
    default:        d = amp;
  }
  return Math.ceil(d * 1.2) + 2;
}

/** Does this layer reach the edge of the frame on all four sides? Read off
    the drawing itself rather than guessed from the placement, because a
    rounded rectangle or a circle can be bigger than the frame and still not
    cover its corners. */
function boilFillsFrame(src) {
  const w = src.width, h = src.height;
  if (w < 4 || h < 4) return false;
  const c = src.getContext('2d', { willReadFrequently: true });
  let seen = 0, solid = 0;
  for (const d of [c.getImageData(0, 0, w, 1).data,
                   c.getImageData(0, h - 1, w, 1).data,
                   c.getImageData(0, 0, 1, h).data,
                   c.getImageData(w - 1, 0, 1, h).data]) {
    const n = d.length / 4;
    const step = Math.max(1, Math.floor(n / 96));
    for (let i = 0; i < n; i += step) { seen++; if (d[i * 4 + 3] > 200) solid++; }
  }
  return seen > 0 && solid / seen > 0.92;
}

/* The bigger scratch the overscanned copy lives in. */
let boilBigCanvas = null;
function boilGrow(src, W, H, pad) {
  const sw = W + pad * 2, sh = H + pad * 2;
  if (!boilBigCanvas) boilBigCanvas = document.createElement('canvas');
  if (boilBigCanvas.width !== sw || boilBigCanvas.height !== sh) {
    boilBigCanvas.width = sw; boilBigCanvas.height = sh;
  }
  const c = boilBigCanvas.getContext('2d', { willReadFrequently: true });
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, sw, sh);
  // One scale for both axes, the larger of the two, so nothing is stretched.
  const s = Math.max(sw / W, sh / H);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, (sw - W * s) / 2, (sh - H * s) / 2, W * s, H * s);
  return boilBigCanvas;
}

/** What boil is set to, as a string. Any change to it invalidates every
    cached drawing, which is the whole point of having it. */
function boilSettingsKey() {
  return [boil.effect, boil.intensity, boil.grain, boil.smooth ? 1 : 0,
          boil.count, boil.edges, boil.seed].join(',');
}

/* The cached drawings. A per-pixel warp of a full frame is tens of
   milliseconds; doing it per frame of a thousand-frame export would be
   minutes. Each distinct picture is warped once and kept. */
const boilCache = new Map();
function boilCacheGet(key) { return boilCache.get(key) || null; }
function boilCachePut(key, canvas) {
  // Bounded, because the mouth alone has nine shapes and a conversation has a
  // cast. Oldest out first — Map keeps insertion order.
  if (boilCache.size > 160) {
    const old = boilCache.keys().next().value;
    const c = boilCache.get(old);
    if (c) { c.width = c.height = 0; }     // let the backing store go
    boilCache.delete(old);
  }
  boilCache.set(key, canvas);
}
function boilForget() {
  boilCache.forEach(c => { c.width = c.height = 0; });
  boilCache.clear();
}

/** Draw one layer, boiled if it is set to boil.

    `drawFn` is handed a context to draw into. With boil off that is the real
    one and nothing is copied. With it on the layer is drawn to a scratch, the
    scratch is warped once per distinct picture, and the cached result is drawn
    back in a single operation — so the layer's opacity and drop shadow apply
    to the finished thing rather than to the warp's working copy. */
function withBoil(ctx, L, W, H, frame, drawFn, contentKey) {
  if (!L || L.boil !== true || !W || !H) { drawFn(ctx); return; }
  const drawing = boilDrawingAt(frame);
  const key = L.id + '|' + W + 'x' + H + '|' + boilSettingsKey() + '|' + drawing +
              '|' + (contentKey == null ? '' : contentKey);
  let hit = boilCacheGet(key);
  if (!hit) {
    const src = boilSource(W, H);
    drawFn(src.getContext('2d'));
    // A layer that reaches all four edges is a background, and a background
    // has to be bigger than the frame or the warp eats its border.
    const pad = boilFillsFrame(src) ? boilOverscan(W, H) : 0;
    const work = pad ? boilGrow(src, W, H, pad) : src;
    hit = document.createElement('canvas');
    hit.width = work.width; hit.height = work.height;
    boilDisplaceInto(hit, work, L, drawing);
    hit.pad = pad;
    boilCachePut(key, hit);
  }
  // The overscanned copy is drawn from its own middle, so the frame holds
  // the same picture it would have held — just with paper to spare.
  ctx.drawImage(hit, -(hit.pad || 0), -(hit.pad || 0));
}

/* ---- the compositor ------------------------------------------------------

   One function builds the picture, and the stage and every export call it. The
   alternative — a preview path and an export path — is how a preview comes to
   be a lie, and this file has had that bug before.

   The plate is the one thing it cannot always draw: a video has to stay a real
   element under the stage canvas, because Safari will not reliably hand a
   hidden one to drawImage. So on the stage a pinned plate is skipped here and
   shows through from underneath; in an export, where the seek has already
   happened, it is drawn like anything else.
--------------------------------------------------------------------------- */

/** Draw the stack into `ctx`. `opts.skipPinned` leaves a video plate to the
    element underneath; `opts.handles` draws the selection box for the layer
    being edited; `opts.frame` is which frame's mouth to use. */
/* `opts.noExtras` draws the plate and the mouth and nothing else; `opts.noFx`
   leaves off the line boil and the drop shadows. Both exist because the video
   exports offer them as boxes — "everything on the stage" is the right default
   and "the mouth on my footage, nothing added" is a real thing to want. They
   are HERE rather than in each export so that whatever an export shows, the
   preview can show the same way. */
function compositeLayers(ctx, W, H, opts) {
  const o = opts || {};
  const shade = (c, L) => { if (!o.noFx) applyLayerShadow(c, L, W); };
  const boiled = (c, L, f, fn, key) =>
    o.noFx ? fn(c) : withBoil(c, L, W, H, f, fn, key);
  const fi = o.frame == null
    ? (state.frames.length ? currentFrameIndex() : 0)
    : o.frame;
  const v = state.frames.length && state.frames[fi] ? state.frames[fi].v : 'X';

  const tSec = fi / Math.max(1, state.fps || 12);
  for (const L of layers) {
    if (!L.visible) continue;
    // A character who has not arrived yet, or has left, is not drawn — and
    // this is in the compositor rather than the preview so it holds in every
    // export as well.
    if (L.kind !== 'mouth' && !layerLiveAt(L, tSec)) continue;
    if (L.kind === 'plate') {
      if (o.skipPinned && layerPinned(L)) continue;
      if (o.drawPlate) {
        ctx.save();
        if (L.opacity != null && L.opacity < 1) ctx.globalAlpha = clamp(L.opacity, 0, 1);
        shade(ctx, L);
        boiled(ctx, L, fi, c2 => o.drawPlate(c2),
               'p|' + puppet.name + '|' + poseKey(puppetPose) + '|' +
               (mirror.plate ? 1 : 0) + '|' + (puppet.kind === 'video' ? fi : ''));
        ctx.restore();
      }
      continue;
    }
    if (L.kind === 'mouth') {
      // One draw per character who has a mouth spot, or — when nobody has one
      // — the single free-floating mouth this has always had. The speaker gets
      // the frame's shape; everyone else sits at rest, which is what makes a
      // two-shot read as two people rather than one talking head and one
      // blank face.
      const pinned = mouthSpotLayers().filter(c => layerLiveAt(c, tSec));
      const talking = speakerAt(tSec);
      const mouths = pinned.length
        ? pinned.map(c => ({ box: mouthSpotBox(c, W, H), v: c === talking ? v : 'X',
                             who: c.id }))
        : [{ box: overlayBox(W, H, o.pose || undefined), v, who: '' }];
      mouths.forEach(m => {
        const b = m.box;
        if (!b) return;
        // The patch belongs under the mouth and over whatever the mouth is
        // covering, and only under the one that is actually talking — smearing
        // the listener's face would be an odd thing to do to them.
        if (m.v === v) drawBlurPatch(ctx, W, H, b);
        ctx.save();
        if (L.opacity != null && L.opacity < 1) ctx.globalAlpha = clamp(L.opacity, 0, 1);
        shade(ctx, L);
        boiled(ctx, L, fi, c2 => {
          c2.save();
          c2.translate(b.cx, b.cy);
          c2.rotate(b.rot);
          c2.drawImage(mouthImage(Math.min(1024, Math.max(16, b.s * 2)), m.v, state.style),
                       -b.s / 2, -b.s / 2, b.s, b.s);
          c2.restore();
        }, 'm|' + m.who + '|' + m.v + '|' + state.style + '|' + (lips.activeId || '') + '|' +
           b.cx.toFixed(1) + ',' + b.cy.toFixed(1) + ',' + b.s.toFixed(1) + ',' + b.rot.toFixed(3));
        ctx.restore();
      });
      continue;
    }
    if (o.noExtras) continue;        // the plate and the mouth, nothing added
    drawExtraLayer(ctx, L, W, H, fi, o.noFx);
  }

  if (o.handles) {
    const L = selectedLayer();
    if (L && L.visible && !(L.kind === 'plate' && !hasPlate())) {
      const b = L.kind === 'mouth' ? overlayBox(W, H) : layerBox(L, W, H);
      if (b) {
        ctx.save();
        ctx.translate(b.cx, b.cy);
        ctx.rotate(b.rot);
        drawOverlayHandles(ctx, b, W, H);
        ctx.restore();
      }
    }
  }
}

/* ---- the panel ------------------------------------------------------------ */

/** A small picture of what a layer holds, for its row in the list. */
function layerThumb(L) {
  const w = 72, h = 46;
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  const x = c.getContext('2d');
  x.scale(2, 2);
  x.fillStyle = 'rgba(128,140,160,.16)';
  x.fillRect(0, 0, w, h);
  try {
    if (L.kind === 'mouth') {
      paintMouthArt(x, h * 1.5, h, 'D', state.style);
    } else if (L.kind === 'plate') {
      const src = plateSource();
      const n = plateNatural();
      if (src && n) {
        const k = Math.min(w / n.w, h / n.h);
        x.drawImage(src, (w - n.w * k) / 2, (h - n.h * k) / 2, n.w * k, n.h * k);
      }
    } else if (L.kind === 'image' && L.img) {
      const k = Math.min(w / L.img.naturalWidth, h / L.img.naturalHeight);
      x.drawImage(L.img, (w - L.img.naturalWidth * k) / 2, (h - L.img.naturalHeight * k) / 2,
                  L.img.naturalWidth * k, L.img.naturalHeight * k);
    } else if (L.kind === 'text') {
      x.fillStyle = L.color || '#fff';
      x.font = '700 15px "Archivo",system-ui,sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText((String(L.text || '').split('\n')[0] || 'Text').slice(0, 10), w / 2, h / 2);
    } else if (L.kind === 'shape') {
      x.save();
      x.translate(w / 2, h / 2);
      const sw = w * 0.56, sh = sw * (L.ar || 0.6);
      x.beginPath();
      if (L.shape === 'ellipse') x.ellipse(0, 0, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      else roundRect(x, -sw / 2, -sh / 2, sw, sh, Math.min(sw, sh) * (L.radius || 0));
      if (L.fill && L.fill !== 'none') { x.fillStyle = L.fill; x.fill(); }
      if (L.stroke && L.strokeW > 0) { x.strokeStyle = L.stroke; x.lineWidth = 2; x.stroke(); }
      x.restore();
    }
  } catch (e) { /* a thumbnail is not worth an exception */ }
  return c;
}

function layerSubtitle(L) {
  const p = layerPose(L);
  const pct = p ? Math.round(p.size * 100) + '%' : '—';
  const rot = p && Math.round(p.rot) ? ' · ' + Math.round(p.rot) + '°' : '';
  const kind = LAYER_KIND_LABEL[L.kind] || L.kind;
  if (L.kind === 'mouth') {
    return kind + ' · ' + pct + rot;
  }
  if (L.kind === 'plate') {
    return kind + ' · ' + pct + rot + (layerPinned(L) ? ' · held at the back' : '');
  }
  if (L.kind === 'image' && L.anim) {
    return kind + ' · ' + pct + rot + ' · ' + L.anim.frames.length + ' frames' +
           (L.animLoop === 'once' ? ' · once'
            : L.animLoop === 'boomerang' ? ' · back and forth' : ' · looping');
  }
  return kind + ' · ' + pct + rot;
}

function renderLayerPanel() {
  const wrap = $('layerList');
  if (!wrap) return;
  // FIRST. Once the editor is living inside the list — which is the whole
  // point of it opening under its own row — `wrap.innerHTML = ''` destroys it
  // outright, and the next line that reaches for it gets null.
  parkLayerEdit();
  wrap.innerHTML = '';
  // Top of the pile first, which is what "layer 1" means to a person. The array
  // itself stays bottom-first because that is the order it is drawn in.
  const shown = [...layers].reverse();
  shown.forEach((L, i) => {
    const row = document.createElement('div');
    row.className = 'lrow' + (L.id === selectedLayerId ? ' sel' : '') +
                    (L.visible ? '' : ' off');
    row.dataset.id = L.id;

    const grip = document.createElement('button');
    grip.className = 'lgrip';
    grip.type = 'button';
    grip.title = layerPinned(L) ? 'A video layer is held at the back' : 'Drag to reorder';
    grip.setAttribute('aria-label', grip.title);
    grip.disabled = layerPinned(L);
    grip.innerHTML = '<svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor">' +
      [3, 8, 13].map(y => '<circle cx="4" cy="' + y + '" r="1.5"/><circle cx="10" cy="' + y + '" r="1.5"/>').join('') +
      '</svg>';

    const eye = document.createElement('button');
    eye.className = 'leye';
    eye.type = 'button';
    eye.setAttribute('aria-pressed', String(L.visible));
    eye.title = L.visible ? 'Hide this layer' : 'Show this layer';
    eye.setAttribute('aria-label', eye.title);
    eye.innerHTML = L.visible
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>'
      : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 12s3.6-6.5 10-6.5c1.7 0 3.2.4 4.5 1"/><path d="M21.3 9.4c.5.9.7 1.4.7 1.4s-3.6 6.5-10 6.5c-1 0-2-.1-2.8-.4"/><path d="M4 20 20 4"/></svg>';

    const num = document.createElement('span');
    num.className = 'lnum mono';
    num.textContent = String(i + 1);

    const thumb = document.createElement('span');
    thumb.className = 'lthumb';
    thumb.appendChild(layerThumb(L));

    const txt = document.createElement('div');
    txt.className = 'ltext';
    const nm = document.createElement('b');
    nm.textContent = L.name || LAYER_KIND_LABEL[L.kind] || 'Layer';
    const sub = document.createElement('span');
    sub.className = 'mono';
    sub.textContent = layerSubtitle(L);
    txt.append(nm, sub);

    const edit = document.createElement('button');
    edit.className = 'lbtn edit';
    edit.type = 'button';
    edit.title = 'Settings for this layer';
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M14 7l3 3"/></svg>';

    const go = document.createElement('button');
    go.className = 'lbtn go';
    go.type = 'button';
    go.title = 'Put the handles on this layer';
    go.setAttribute('aria-label', go.title);
    go.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="m13 6 6 6-6 6"/></svg>';

    const del = document.createElement('button');
    del.className = 'lbtn danger';
    del.type = 'button';
    del.disabled = L.kind === 'mouth';
    del.title = L.kind === 'mouth' ? 'The mouth is why the app exists'
              : L.kind === 'plate' ? 'Remove the puppet' : 'Delete this layer';
    del.setAttribute('aria-label', del.title);
    del.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/></svg>';

    eye.onclick = e => { e.stopPropagation(); setLayerVisible(L.id, !L.visible); };
    edit.onclick = e => { e.stopPropagation(); selectLayer(L.id); openLayerEditor(L.id); };
    go.onclick = e => { e.stopPropagation(); selectLayer(L.id); };
    del.onclick = e => { e.stopPropagation(); deleteLayer(L.id); };
    row.onclick = () => selectLayer(L.id);

    row.append(grip, eye, num, thumb, txt, edit, go, del);
    wireLayerDrag(row, grip, L);
    wrap.appendChild(row);
    // The settings box goes DIRECTLY UNDER the row it belongs to. It used to
    // sit at the bottom of the list, which with four layers put "Picture
    // settings" under a row it had nothing to do with and read as a panel for
    // the list rather than for one layer.
    if (L.id === layerEditorId) {
      const ed = $('layerEdit');
      if (ed) wrap.appendChild(ed);
    }
  });
  renderLayerEditor();
  syncLayerSelect();
  // The row's switch reads "on for every layer", so it has to be recomputed
  // whenever the set of layers or their ticks change.
  syncBoilUI();
  renderTurns();
}

/* ---- the list's own drag-to-reorder ---------------------------------------

   Pointer events rather than HTML5 drag-and-drop: the latter has no useful
   touch story, and this list is as likely to be used on an iPad as on a desk.
   The row follows the finger, the others shuffle, and the drop is worked out
   from where the row's middle ended up. */
function wireLayerDrag(row, grip, L) {
  if (layerPinned(L)) return;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    const list = row.parentElement;
    const rows = [...list.children];
    const startY = e.clientY;
    const h = row.getBoundingClientRect().height + 8;
    const from = rows.indexOf(row);
    let to = from;
    row.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    const move = ev => {
      const dy = ev.clientY - startY;
      row.style.transform = 'translateY(' + dy + 'px)';
      const want = clamp(from + Math.round(dy / h), 0, rows.length - 1);
      if (want !== to) {
        to = want;
        rows.forEach((r, i) => {
          if (r === row) return;
          let shift = 0;
          if (from < to && i > from && i <= to) shift = -h;
          else if (from > to && i < from && i >= to) shift = h;
          r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        });
      }
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      rows.forEach(r => { r.style.transform = ''; });
      row.classList.remove('dragging');
      if (to !== from) moveLayerToDisplayIndex(L.id, to);
      else renderLayerPanel();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

/** The panel counts from the top; the array is stored from the bottom. One
    conversion, in one place, so the rest of the code never has to think about
    it again. */
function moveLayerToDisplayIndex(id, displayIndex) {
  const L = layerById(id);
  if (!L) return;
  const rest = layers.filter(x => x !== L);
  const target = rest.length - clamp(displayIndex, 0, rest.length);
  rest.splice(target, 0, L);
  // A pinned video is still pinned, whatever the drop said.
  const p = rest.find(x => layerPinned(x));
  layers = p ? [p, ...rest.filter(x => x !== p)] : rest;
  bankLayers();
  renderLayerPanel();
  drawStage();
  updateEstimates();
  pushStageHistory();
}


/* ---- what the buttons do -------------------------------------------------- */

function bankLayers() {
  const c = activeClip();
  if (c) c.layers = layers.map(L => ({ ...L }));
}

/* ---- undo on the stage -------------------------------------------------------

   The exposure sheet has had undo from the start, because retiming a run by
   hand is destructive and obviously needs taking back. The stage had none: a
   mouth nudged off a face, a picture dragged to the wrong place, a layer
   deleted — all of it one-way, and the only way back was to do it again by
   hand and hope you remembered the number.

   What is kept is a SNAPSHOT of the stack rather than a list of commands. A
   command log is smaller and would mean writing an inverse for every action,
   including the ones added later; a snapshot is correct for anything by
   construction, and a stack of thirty is a few hundred kilobytes because the
   pictures themselves are shared, not copied.

   Timing is the whole trick:

   - a drag commits ONCE, when the pointer is released, not on every move;
   - a slider or a typed field commits after a short pause, so dragging a
     slider across its range is one entry and not two hundred;
   - and opening a clip replaces the history rather than adding to it, because
     undoing past the moment a clip was opened would restore another clip's
     stack onto this one.
--------------------------------------------------------------------------- */

const stageHistory = { stack: [], at: -1 };
/* One counter for both histories. Every entry carries the moment its action
   happened, which is what lets ⌘Z walk back through what you actually did
   even though the sheet and the stage keep separate stacks. Undoing does NOT
   re-stamp anything: the question "which did I do last" is about the actions,
   not about the taking back of them. */
let editClock = 0;
let stageHistTimer = null;

/** One layer, copied far enough that nothing in the snapshot can be mutated
    from under it. The decoded picture, the File and the decoded animation are
    SHARED on purpose: they are read-only and they are the expensive part. */
function cloneLayerState(L) {
  const c = { ...L };
  if (L.pose) c.pose = { ...L.pose };
  if (L.shadow) c.shadow = { ...L.shadow };
  if (L.mouthSpot) c.mouthSpot = { ...L.mouthSpot };
  if (L.boil) c.boil = { ...L.boil };
  return c;
}

function stageSnapshot() {
  const c = activeClip();
  return {
    // Which PICTURE is behind the mouth, not the decoded bitmap. "Remove" is
    // one of the things most worth taking back, and a snapshot that left the
    // puppet out would undo everything about a clip except the thing that had
    // just gone.
    puppet: c && c.puppet ? { ...c.puppet } : null,
    layers: layers.map(cloneLayerState),
    overlay: JSON.parse(JSON.stringify(overlay)),
    puppetPose: { ...puppetPose },
    mirror: { ...mirror },
    patch: { ...patch },
    canvas: { ...canvasSetting },
    selected: selectedLayerId,
  };
}

function resetStageHistory() {
  const first = stageSnapshot();
  first.at = 0;
  stageHistory.stack = [first];
  stageHistory.at = 0;
  syncStageHistoryButtons();
}

/** Record what the stage looks like now, as one step. */
function pushStageHistory() {
  clearTimeout(stageHistTimer);
  stageHistTimer = null;
  // Putting a snapshot back is not itself a step.
  if (restoringStage) return;
  if (!stageHistory.stack.length) return resetStageHistory();
  const snap = stageSnapshot();
  // Nothing actually changed — a click that selected something, a slider put
  // back where it started. An undo that does nothing is worse than no undo.
  if (sameStageState(snap, stageHistory.stack[stageHistory.at])) return;
  snap.at = ++editClock;
  stageHistory.stack = stageHistory.stack.slice(0, stageHistory.at + 1);
  stageHistory.stack.push(snap);
  if (stageHistory.stack.length > 40) stageHistory.stack.shift();
  stageHistory.at = stageHistory.stack.length - 1;
  syncStageHistoryButtons();
}

/** The same, but after a pause — for sliders and typing, where every tick
    would otherwise be its own step. */
function pushStageHistorySoon(ms) {
  clearTimeout(stageHistTimer);
  stageHistTimer = setTimeout(pushStageHistory, ms == null ? 450 : ms);
}

function sameStageState(a, b) {
  if (!a || !b) return false;
  const strip = s => JSON.stringify({
    sel: s.selected, ov: s.overlay, pp: s.puppetPose, mi: s.mirror,
    pa: s.patch, ca: s.canvas,
    pu: s.puppet && s.puppet.file ? s.puppet.file.name + ':' + s.puppet.file.size : null,
    ls: s.layers.map(L => {
      const o = {};
      Object.keys(L).forEach(k => {
        const v = L[k];
        if (k === 'img' || k === 'anim' || k === 'file' || k === 'el') { o[k] = !!v; return; }
        if (v && typeof v === 'object') { o[k] = JSON.parse(JSON.stringify(v)); return; }
        o[k] = v;
      });
      return o;
    }),
  });
  try { return strip(a) === strip(b); } catch (e) { return false; }
}

let restoringStage = false;

function applyStageSnapshot(s) {
  restoringStage = true;
  const c = activeClip();
  const was = c && c.puppet ? c.puppet.file : null;
  const want = s.puppet ? s.puppet.file : null;
  if (c && was !== want) {
    c.puppet = s.puppet ? { ...s.puppet } : null;
    // Asynchronous by nature — the picture has to decode. The rest of the
    // stack goes back now and the plate lands when it lands, exactly as it
    // does when a clip is opened.
    plateReady = restorePuppet(c).then(() => { syncPuppetUI(); drawStage(); });
  }
  layers = s.layers.map(cloneLayerState);
  Object.assign(overlay, JSON.parse(JSON.stringify(s.overlay)));
  Object.assign(puppetPose, s.puppetPose);
  Object.assign(mirror, s.mirror);
  Object.assign(patch, s.patch);
  Object.assign(canvasSetting, s.canvas);
  selectedLayerId = layerById(s.selected) ? s.selected : (layers[0] || {}).id || null;
  if (layerEditorId && !layerById(layerEditorId)) layerEditorId = null;
  bankLayers();
  renderLayerPanel();
  syncLayerSelect();
  syncPatchUI();
  syncMirrorUI();
  syncCanvasUI();
  sizeStage();
  drawStage();
  updateOverlayReadout();
  updateEstimates();
  restoringStage = false;
}

function stageUndo() {
  pushStageHistory();                  // commit anything still pending
  if (stageHistory.at <= 0) return false;
  stageHistory.at--;
  applyStageSnapshot(stageHistory.stack[stageHistory.at]);
  syncStageHistoryButtons();
  return true;
}

function stageRedo() {
  if (stageHistory.at >= stageHistory.stack.length - 1) return false;
  stageHistory.at++;
  applyStageSnapshot(stageHistory.stack[stageHistory.at]);
  syncStageHistoryButtons();
  return true;
}

function syncStageHistoryButtons() {
  const u = $('stageUndo'), r = $('stageRedo');
  if (u) u.disabled = stageHistory.at <= 0;
  if (r) r.disabled = stageHistory.at >= stageHistory.stack.length - 1;
}

function selectLayer(id) {
  if (selectedLayerId === id) return;
  selectedLayerId = id;
  // The handles on the stage follow the selection, so the old two-position
  // Mouth/Puppet switch is now just "which layer is selected".
  const L = layerById(id);
  renderLayerPanel();
  updateOverlayReadout();
  drawStage();
}

function setLayerVisible(id, on) {
  const L = layerById(id);
  if (!L) return;
  L.visible = !!on;
  bankLayers();
  renderLayerPanel();
  drawStage();
  updateEstimates();
}

function deleteLayer(id) {
  const L = layerById(id);
  if (!L || L.kind === 'mouth') return;
  if (L.kind === 'plate') { forgetPuppet(); return; }   // its own machinery
  layers = layers.filter(x => x !== L);
  if (selectedLayerId === id) selectedLayerId = (mouthLayer() || layers[0] || {}).id || null;
  if (layerEditorId === id) layerEditorId = null;
  bankLayers();
  renderLayerPanel();
  // The selection just moved to the mouth, so the strip's size range, its
  // number fields and whether its Delete is allowed are all now wrong until
  // this runs. Left out, the Delete stayed live over a mouth it would refuse.
  updateOverlayReadout();
  drawStage();
  updateEstimates();
}

/** New layers go in directly above whatever is selected, which is where you
    looked last and therefore where you meant. */
function addLayer(L) {
  L.id = newLayerId();
  if (L.visible == null) L.visible = true;
  if (!L.pose) L.pose = { x: 0.5, y: 0.5, size: 0.4, rot: 0 };
  const at = layers.findIndex(x => x.id === selectedLayerId);
  layers.splice(at < 0 ? layers.length : at + 1, 0, L);
  selectedLayerId = L.id;
  layerEditorId = L.id;
  // The first thing added to an empty stack brings the mouth with it: there is
  // now a picture for it to be placed on. (The stack is empty before that —
  // see syncLayers.)
  syncLayers();
  bankLayers();
  renderLayerPanel();
  drawStage();
  updateEstimates();
  pushStageHistory();
  return L;
}

async function addImageLayerFromFile(file) {
  if (!file) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('it would not decode as a picture'));
      i.src = url;
    });
    // Measured off the short edge, the same reasoning as a puppet: 40% of the
    // width of a tall picture is not 40% of what you can see.
    // An animated GIF or PNG is decoded here, once, into real frames. The
    // <img> is kept anyway: it is what the thumbnail and the proportions are
    // read from, and it is the right picture to draw if the decode fails.
    let anim = null;
    try {
      anim = await decodeAnimation(file);
    } catch (e) {
      toast('That picture animates, but it is too big to hold — using its first ' +
            'frame. (' + (e.message || e) + ')', 6000);
    }
    const L = addLayer({
      kind: 'image', name: file.name.replace(/\.[^.]+$/, ''),
      file, img, url, mirror: false, opacity: 1, anim,
      animLoop: 'loop', animSpeed: 1, animStart: 0,
      pose: { x: 0.5, y: 0.5, size: 0.4, rot: 0 }
    });
    toast(anim
      ? 'Layer added — ' + L.name + ' · ' + anim.frames.length + ' frames, ' +
        fmtTime(anim.total) + ', looping'
      : 'Layer added — ' + L.name, anim ? 4000 : 2200);
    return L;
  } catch (e) {
    URL.revokeObjectURL(url);
    toast('Could not use that picture — ' + (e.message || e), 4000);
    return null;
  }
}

function addTextLayer() {
  addLayer({
    kind: 'text', name: 'Text', text: 'Hello', color: '#FFFFFF',
    stroke: '#101418', strokeW: 0.14, font: 'sans', weight: 700, opacity: 1,
    pose: { x: 0.5, y: 0.18, size: 0.09, rot: 0 }
  });
}

function addShapeLayer() {
  addLayer({
    kind: 'shape', name: 'Shape', shape: 'rect', fill: '#FFFFFF',
    stroke: '#101418', strokeW: 0.004, radius: 0.12, ar: 0.5, opacity: 1,
    pose: { x: 0.5, y: 0.5, size: 0.45, rot: 0 }
  });
}

/** A speech balloon, with words in it and a tail already aimed down-left at
    where a character usually stands. Its own button rather than "add a shape,
    then find the right entry in a list": a balloon is the thing people come to
    a lip-sync tool wanting to add, and it should be one press. */
function addBalloonLayer(kind) {
  const k = kind || 'speech';
  const name = (SHAPE_KINDS.find(e => e[0] === k) || [, 'Balloon'])[1];
  addLayer({
    kind: 'shape', name, shape: k,
    text: k === 'caption' ? 'Meanwhile…' : k === 'thought' ? 'Hmm…' : 'Say something',
    textColor: '#101418', textSize: 0.12, font: 'sans', weight: 700,
    fill: '#FFFFFF', stroke: '#101418', strokeW: 0.005,
    radius: 0.12, ar: k === 'caption' || k === 'banner' ? 0.34 : 0.62,
    tailAt: 125, tailLen: 0.55, tailWide: 0.26, spikes: 12, spikeDepth: 0.72,
    bumps: 11, seed: 1 + Math.floor(Math.random() * 90), opacity: 1,
    pose: { x: 0.5, y: 0.26, size: 0.42, rot: 0 }
  });
}

/* ---- the open/close editor ------------------------------------------------ */

let layerEditorId = null;

function openLayerEditor(id) {
  layerEditorId = layerEditorId === id ? null : id;
  renderLayerPanel();
}

/** A slider with its value beside it, for the layer editor.

    Every one of these was a number field. A number field is the right control
    for a value you already know and the wrong one for a value you are looking
    for — and "this picture came in four times too big" is always the second
    kind. `fmt` formats the readout; `scale` converts between the slider's
    integer and the value actually stored. */
function makeSlider(value, oninput, attrs) {
  const a = attrs || {};
  const wrap = document.createElement('span');
  wrap.className = 'lslide';
  const i = document.createElement('input');
  i.type = 'range';
  if (a.min != null) i.min = a.min;
  if (a.max != null) i.max = a.max;
  if (a.step != null) i.step = a.step;
  i.value = value;
  // And the typeable half. A slider finds a value; a field states one, and
  // "113%" is a thing you state. Each writes to the other so whichever you
  // used last is what both of them show.
  const n = document.createElement('input');
  n.type = 'number';
  n.className = 'num';
  if (a.min != null) n.min = a.min;
  if (a.max != null) n.max = a.max;
  n.step = a.numStep != null ? a.numStep : 1;
  n.value = value;
  const unit = document.createElement('span');
  unit.className = 'hint';
  unit.textContent = a.unit || '';
  i.oninput = () => { n.value = i.value; oninput(i.value); };
  n.oninput = () => {
    const v = parseFloat(n.value);
    if (!Number.isFinite(v)) return;            // mid-edit "-" or "": leave it
    i.value = String(Math.round(clamp(v, +n.min, +n.max)));
    oninput(n.value);
  };
  n.addEventListener('keydown', e => { if (e.key === 'Enter') n.blur(); });
  wrap.append(i, n);
  if (a.unit) wrap.append(unit);
  return wrap;
}

function fieldRow(label, el) {
  const d = document.createElement('label');
  d.className = 'lfield';
  const s = document.createElement('span');
  s.textContent = label;
  d.append(s, el);
  return d;
}

function makeInput(type, value, oninput, attrs) {
  const i = document.createElement('input');
  i.type = type;
  if (value != null) i.value = value;
  Object.assign(i, attrs || {});
  i.oninput = () => oninput(i.value);
  return i;
}

function makeSelect(options, value, onchange) {
  const s = document.createElement('select');
  options.forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    s.appendChild(o);
  });
  s.value = value;
  s.onchange = () => onchange(s.value);
  return s;
}

/* ---- the blur patch and the keyframes, where they belong --------------------

   Both belong to the MOUTH. They were in a panel of their own under the stage,
   which made them look like settings for the preview rather than for a layer,
   and left the mouth's own settings panel oddly empty next to every other
   layer's.

   They are MOVED rather than rebuilt: the same two elements, adopted into the
   mouth's editor and parked back in their old home when it closes. Rebuilding
   them there would mean a second copy of every id, and two controls claiming
   to be `#patchOn` is how one of them silently stops working.
--------------------------------------------------------------------------- */
const MOTION_ROWS = ['patchRow'];

/** Put the layer editor back in its own home, outside the list. Called before
    anything clears the list, which would otherwise take it with it. */
function parkLayerEdit() {
  const ed = $('layerEdit'), home = $('layerPane');
  if (ed && home && ed.parentNode !== home) home.appendChild(ed);
}

/** Put them back where the markup has them, before anything clears the editor
    they are currently sitting in. */
function parkMotionRows() {
  const body = $('rowPark');
  if (!body) return;
  MOTION_ROWS.forEach(id => {
    const el = $(id);
    if (el && el.parentNode !== body) body.appendChild(el);
  });
}

function renderLayerEditor() {
  const host = $('layerEdit');
  if (!host) return;
  // FIRST, always: innerHTML = '' two lines down would otherwise destroy the
  // two rows outright the moment the editor was closed or switched to another
  // layer, taking every control on them with it.
  parkMotionRows();
  host.innerHTML = '';
  const L = layerById(layerEditorId);
  host.hidden = !L;
  if (!L) { overlayToolsVisible(placeable()); return; }

  // Every change in here is undoable, but a slider dragged across its range
  // is ONE step rather than two hundred: the commit waits for the dragging to
  // stop. `pushStageHistorySoon` is the whole of that rule.
  const touch = () => { bankLayers(); drawStage(); updateEstimates(); pushStageHistorySoon(); };
  const touchAndList = () => { touch(); renderLayerPanel(); };
  /* Typing is different from every other control in here.

     `touchAndList` rebuilds the layer list, and the settings box lives INSIDE
     that list — so rebuilding it while you are typing destroys the textarea
     the cursor is in and the next letter goes nowhere. Reported as "after each
     letter the system throws the cursor out of the box", which is exactly what
     an element replaced under the caret feels like.

     So typing redraws the STAGE on every keystroke, which is the part you want
     to see, and the list is rebuilt once, on the way out. */
  const typeInto = (el, set) => {
    el.oninput = () => { set(el.value); touch(); };
    el.onchange = () => { set(el.value); touchAndList(); };
  };

  const head = document.createElement('div');
  head.className = 'lehead';
  const h = document.createElement('b');
  h.textContent = (LAYER_KIND_LABEL[L.kind] || 'Layer') + ' settings';
  const done = document.createElement('button');
  done.className = 'btn ghost mini';
  done.type = 'button';
  done.style.width = 'auto';
  done.textContent = 'Done';
  done.onclick = () => { layerEditorId = null; renderLayerPanel(); };
  head.append(h, document.createElement('span'), done);
  head.children[1].className = 'tspacer';
  host.appendChild(head);

  const body = document.createElement('div');
  body.className = 'lebody';
  host.appendChild(body);

  if (L.kind !== 'plate' && L.kind !== 'mouth') {
    body.appendChild(fieldRow('Name', makeInput('text', L.name, v => {
      L.name = v;
      const row = document.querySelector('.lrow[data-id="' + L.id + '"] .ltext b');
      if (row) row.textContent = v;
      bankLayers();
    })));
  }

  // --- the placement, the same three numbers the stage handles drive --------
  const p = layerPose(L);
  const szMax = L.kind === 'mouth' ? 160 : 400;
  body.appendChild(fieldRow('Size', makeSlider(Math.round(p.size * 100), v => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) { p.size = clamp(n / 100, 0.02, 4); touchAndList(); }
  }, { min: 2, max: szMax, step: 1, unit: '%', numStep: 0.1 })));
  body.appendChild(fieldRow('Angle', makeSlider(Math.round(p.rot), v => {
    const n = parseFloat(v);
    if (Number.isFinite(n)) { p.rot = normDeg(n); touchAndList(); }
  }, { min: -180, max: 180, step: 1, unit: '°', numStep: 0.5 })));
  body.appendChild(fieldRow('Opacity', makeSlider(
    Math.round((L.opacity == null ? 1 : L.opacity) * 100), v => {
      const n = parseFloat(v);
      if (Number.isFinite(n)) { L.opacity = clamp(n / 100, 0, 1); touch(); }
    }, { min: 0, max: 100, step: 1, unit: '%' })));

  // --- per kind -------------------------------------------------------------
  if (L.kind === 'mouth') {
    // The two rows themselves, adopted. Everything already wired to them keeps
    // working because they are the same elements.
    MOTION_ROWS.forEach(id => {
      const el = $(id);
      if (el) { el.hidden = false; body.appendChild(el); }
    });
  }
  if (L.kind === 'image') {
    const m = document.createElement('button');
    m.className = 'btn ghost mini'; m.type = 'button'; m.style.width = 'auto';
    m.textContent = L.mirror ? 'Un-mirror' : 'Mirror';
    m.onclick = () => { L.mirror = !L.mirror; touchAndList(); };
    body.appendChild(fieldRow('Flip', m));
    // Only for a picture that actually moves. A still has nothing to loop, and
    // three dead controls on every picture is worse than none.
    if (L.anim) {
      body.appendChild(fieldRow('Loop', makeSelect(ANIM_LOOPS, L.animLoop || 'loop',
        v => { L.animLoop = v; touchAndList(); })));
      body.appendChild(fieldRow('Speed', makeSlider(
        Math.round((L.animSpeed == null ? 1 : L.animSpeed) * 100),
        v => { const n = parseFloat(v);
               if (Number.isFinite(n)) { L.animSpeed = clamp(n / 100, 0.05, 8); touch(); } },
        { min: 5, max: 800, step: 5, unit: '%', numStep: 1 })));
      // Where in the take it starts, so two animated layers need not be in
      // lockstep and a loop can be made to land on a beat.
      body.appendChild(fieldRow('Start at', makeSlider(
        Math.round((L.animStart || 0) * 10),
        v => { const n = parseFloat(v);
               if (Number.isFinite(n)) { L.animStart = clamp(n / 10, 0, 120); touch(); } },
        { min: 0, max: 300, step: 1, unit: 's', numStep: 1 })));
      const note = document.createElement('span');
      note.className = 'hint';
      const sp = L.animSpeed == null ? 1 : L.animSpeed;
      note.textContent = L.anim.frames.length + ' frames · ' +
        fmtTime(L.anim.total / Math.max(0.05, sp)) + ' a cycle · ' +
        (L.anim.loops ? 'the file asks for ' + L.anim.loops + ' play' +
                        (L.anim.loops === 1 ? '' : 's') : 'the file loops forever');
      const row = fieldRow('', note);
      row.style.gridColumn = '1 / -1';
      body.appendChild(row);
    }
  }
  if (L.kind === 'text') {
    const ta = document.createElement('textarea');
    ta.rows = 2; ta.value = L.text || '';
    typeInto(ta, v => { L.text = v; });
    body.appendChild(fieldRow('Words', ta));
    body.appendChild(fieldRow('Colour', makeInput('color', L.color || '#FFFFFF',
      v => { L.color = v; touchAndList(); })));
    body.appendChild(fieldRow('Outline', makeInput('color', L.stroke || '#101418',
      v => { L.stroke = v; touchAndList(); })));
    body.appendChild(fieldRow('Outline w', makeSlider(Math.round((L.strokeW || 0) * 100),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.strokeW = clamp(n / 100, 0, 0.6); touch(); } },
      { min: 0, max: 60, step: 1 })));
    body.appendChild(fieldRow('Typeface', makeSelect(
      [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], L.font || 'sans',
      v => { L.font = v; touchAndList(); })));
    body.appendChild(fieldRow('Weight', makeSelect(
      [['400', 'Regular'], ['600', 'Medium'], ['700', 'Bold'], ['800', 'Heavy']],
      String(L.weight || 700), v => { L.weight = parseInt(v, 10); touchAndList(); })));
  }
  if (L.kind === 'shape') {
    body.appendChild(fieldRow('Shape', makeSelect(
      SHAPE_KINDS, L.shape || 'rect',
      v => {
        L.shape = v;
        // A balloon with no words in it is a blank oval, and a panel that
        // keeps a speech balloon's tail is a mistake nobody means to make.
        if (shapeHoldsWords(L) && L.text == null) L.text = 'Say something';
        if (L.textColor == null) L.textColor = '#101418';
        touchAndList();
      })));
    if (shapeHoldsWords(L)) {
      const ta = document.createElement('textarea');
      ta.rows = 2; ta.value = L.text || '';
      typeInto(ta, v => { L.text = v; });
      body.appendChild(fieldRow('Words', ta));
      body.appendChild(fieldRow('Word size', makeSlider(Math.round((L.textSize == null ? 0.13 : L.textSize) * 100),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.textSize = clamp(n / 100, 0.02, 0.6); touch(); } },
        { min: 2, max: 60, step: 1, unit: '%' })));
      body.appendChild(fieldRow('Word colour', makeInput('color', L.textColor || '#101418',
        v => { L.textColor = v; touchAndList(); })));
      body.appendChild(fieldRow('Typeface', makeSelect(
        [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], L.font || 'sans',
        v => { L.font = v; touchAndList(); })));
    }
    if (isBalloon(L)) {
      body.appendChild(fieldRow('Tail at', makeSlider(Math.round(L.tailAt == null ? 125 : L.tailAt),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.tailAt = ((n % 360) + 360) % 360; touch(); } },
        { min: 0, max: 359, step: 1, unit: '°' })));
      body.appendChild(fieldRow('Tail out', makeSlider(Math.round((L.tailLen == null ? 0.55 : L.tailLen) * 100),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.tailLen = clamp(n / 100, 0, 2); touch(); } },
        { min: 0, max: 200, step: 5, unit: '%' })));
    }
    if (L.shape === 'burst') {
      body.appendChild(fieldRow('Points', makeSlider(Math.round(L.spikes == null ? 12 : L.spikes),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.spikes = clamp(Math.round(n), 6, 30); touch(); } },
        { min: 6, max: 30, step: 1 })));
      body.appendChild(fieldRow('Point depth', makeSlider(Math.round((L.spikeDepth == null ? 0.72 : L.spikeDepth) * 100),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.spikeDepth = clamp(n / 100, 0.3, 0.95); touch(); } },
        { min: 30, max: 95, step: 1, unit: '%' })));
    }
    body.appendChild(fieldRow('Fill', makeInput('color', L.fill === 'none' ? '#FFFFFF' : (L.fill || '#FFFFFF'),
      v => { L.fill = v; touchAndList(); })));
    const nf = document.createElement('button');
    nf.className = 'btn ghost mini'; nf.type = 'button'; nf.style.width = 'auto';
    nf.textContent = L.fill === 'none' ? 'Filled' : 'No fill';
    nf.onclick = () => { L.fill = L.fill === 'none' ? '#FFFFFF' : 'none'; touchAndList(); };
    body.appendChild(fieldRow('', nf));
    body.appendChild(fieldRow('Edge', makeInput('color', L.stroke || '#101418',
      v => { L.stroke = v; touchAndList(); })));
    body.appendChild(fieldRow('Edge w', makeSlider(Math.round((L.strokeW || 0) * 1000),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.strokeW = clamp(n / 1000, 0, 0.05); touch(); } },
      { min: 0, max: 50, step: 1 })));
    body.appendChild(fieldRow('Tall/wide', makeSlider(Math.round((L.ar || 0.6) * 100),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.ar = clamp(n / 100, 0.05, 6); touchAndList(); } },
      { min: 5, max: 600, step: 5, unit: '%' })));
    if (L.shape === 'rect') {
      body.appendChild(fieldRow('Corners', makeSlider(Math.round((L.radius || 0) * 100),
        v => { const n = parseFloat(v); if (Number.isFinite(n)) { L.radius = clamp(n / 100, 0, 0.5); touchAndList(); } },
        { min: 0, max: 50, step: 1 })));
    }
  }

  // --- the mouth spot, for anything that can wear a face -------------------
  if (canHoldMouth(L)) {
    const btn = document.createElement('button');
    btn.className = 'btn ghost mini'; btn.type = 'button'; btn.style.width = 'auto';
    btn.textContent = L.mouthSpot ? 'Move it here' : 'Put the mouth here';
    btn.title = 'Take where the mouth is standing now and pin it to this character';
    btn.onclick = () => {
      const st = $('stage');
      const sp = spotFromOverlay(L, st.width, st.height, livePose());
      if (!sp) return;
      L.mouthSpot = sp;
      const lifted = liftMouthOverFaces();
      seedTurns(activeClip());
      touchAndList();
      renderTurns();
      toast('The mouth belongs to ' + (L.name || 'this layer') +
            ' now — move or resize them and it goes too.' +
            (lifted ? ' Moved it above the faces so it is not painted over.' : ''), 4600);
    };
    const row = fieldRow('Mouth', btn);
    const note = document.createElement('span');
    note.className = 'hint';
    if (L.mouthSpot) {
      const off = document.createElement('button');
      off.className = 'btn ghost mini'; off.type = 'button'; off.style.width = 'auto';
      off.textContent = 'Unpin';
      off.onclick = () => { L.mouthSpot = null; touchAndList(); renderTurns(); };
      row.appendChild(off);
      note.textContent = 'pinned at ' + Math.round(L.mouthSpot.x * 100) + ', ' +
                         Math.round(L.mouthSpot.y * 100) + ' · ' +
                         Math.round(L.mouthSpot.size * 100) + '% of this layer';
    } else {
      note.textContent = 'place the mouth on the stage, then press this — ' +
                         'two characters with pinned mouths become a two-hander';
    }
    row.appendChild(note);
    row.style.gridColumn = '1 / -1';
    body.appendChild(row);
  }

  // --- when this layer is on screen ----------------------------------------
  if (L.kind !== 'mouth') {
    const dur = state.buffer ? state.buffer.duration : 0;
    const mk = (label, get, set) => {
      const i = document.createElement('input');
      i.type = 'number'; i.className = 'num';
      i.min = 0; i.max = Math.max(1, Math.ceil(dur)); i.step = 0.1;
      i.placeholder = label === 'On from' ? 'start' : 'end';
      const v = get();
      i.value = v == null ? '' : (+v).toFixed(1);
      i.oninput = () => {
        const n = parseFloat(i.value);
        set(i.value === '' || !Number.isFinite(n) ? null : clamp(n, 0, dur || n));
        touch();
      };
      return fieldRow(label, i);
    };
    body.appendChild(mk('On from', () => L.from, v => { L.from = v; }));
    body.appendChild(mk('Off at', () => L.to, v => { L.to = v; }));
  }

  // --- line boil, per layer ------------------------------------------------
  // On for everything by default, because the point of it is that the whole
  // drawing breathes together; the opt-out is for the layer that should not —
  // a title card, a logo, a background that is meant to be solid.
  const bo = document.createElement('input');
  bo.type = 'checkbox';
  bo.checked = L.boil === true;
  bo.onchange = () => {
    L.boil = bo.checked;
    syncBoilUI();
    touchAndList();
    if (bo.checked) runBoilDemo();
  };
  const bf = fieldRow('Line boil', bo);
  const bn = document.createElement('span');
  bn.className = 'hint';
  // Say what it will actually do to THIS layer, in pixels, rather than
  // describing the state of something else. The old note here read "off for
  // the whole stack", which answered a question nobody had asked and did not
  // say what the tick next to it was for.
  if (L.boil === true) {
    const fx = BOIL_EFFECTS.find(x => x[0] === boil.effect);
    bn.textContent = (fx ? fx[1].toLowerCase() : 'boiling') + ', about ±' +
                     boilPixels() + 'px, ' + boil.count + ' drawings at ' +
                     boil.fps + ' fps — set it in the Line boil row above';
  } else {
    bn.textContent = 'off — tick to make this layer wobble';
  }
  if (L.kind === 'plate' && layerPinned(L)) {
    bn.textContent = 'a video puppet cannot boil — it is the element under the ' +
                     'canvas, not something drawn into it';
    bo.disabled = true;
  }
  bf.appendChild(bn);
  body.appendChild(bf);

  // --- the drop shadow, which every kind can have --------------------------
  const sh = L.shadow || (L.shadow = { on: false, blur: 0.02, dx: 0.006, dy: 0.010, color: '#000000', alpha: 0.5 });
  const on = document.createElement('input');
  on.type = 'checkbox'; on.checked = !!sh.on;
  on.onchange = () => { sh.on = on.checked; touchAndList(); };
  body.appendChild(fieldRow('Drop shadow', on));
  if (sh.on) {
    body.appendChild(fieldRow('Softness', makeSlider(Math.round(sh.blur * 1000),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { sh.blur = clamp(n / 1000, 0, 0.2); touch(); } },
      { min: 0, max: 200, step: 2 })));
    body.appendChild(fieldRow('Across', makeSlider(Math.round(sh.dx * 1000),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { sh.dx = clamp(n / 1000, -200, 200); touch(); } },
      { min: -200, max: 200, step: 2 })));
    body.appendChild(fieldRow('Down', makeSlider(Math.round(sh.dy * 1000),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { sh.dy = clamp(n / 1000, -200, 200); touch(); } },
      { min: -200, max: 200, step: 2 })));
    body.appendChild(fieldRow('Colour', makeInput('color', sh.color || '#000000',
      v => { sh.color = v; touch(); })));
    body.appendChild(fieldRow('Strength', makeSlider(Math.round((sh.alpha == null ? 0.5 : sh.alpha) * 100),
      v => { const n = parseFloat(v); if (Number.isFinite(n)) { sh.alpha = clamp(n / 100, 0, 1); touch(); } },
      { min: 0, max: 100, step: 1, unit: '%' })));
  }
}

/* ---- the canvas control --------------------------------------------------- */

function syncCanvasUI() {
  const sel = $('canvasPreset');
  if (!sel) return;
  if (!sel.childElementCount) {
    CANVAS_PRESETS.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    });
  }
  const pz = plateSize();
  sel.options[0].textContent = pz ? 'Match the puppet (' + pz.w + ' × ' + pz.h + ')'
                                  : 'Match the puppet';
  const key = canvasSetting.mode === 'auto' || canvasSetting.mode === 'custom'
    ? canvasSetting.mode
    : canvasSetting.w + 'x' + canvasSetting.h;
  sel.value = CANVAS_PRESETS.some(([v]) => v === key) ? key : 'custom';
  const cust = $('canvasCustom');
  if (cust) cust.hidden = sel.value !== 'custom';
  const w = $('canvasW'), h = $('canvasH');
  const f = frameSize();
  if (w && document.activeElement !== w) w.value = f.w;
  if (h && document.activeElement !== h) h.value = f.h;
  const note = $('canvasNote');
  if (note) {
    const g = gcd(f.w, f.h);
    // And say when something is off the edge. "Match the puppet" pins the
    // frame to the FIRST picture, so everything added afterwards has to live
    // inside that shape — which is fine until it isn't, and until now there
    // was nothing on screen to say that was what had happened, or that one
    // menu item undid it.
    const e = stackExtent();
    note.textContent = f.w + ' × ' + f.h + '  ·  ' + (f.w / g) + ':' + (f.h / g) +
      (e ? '  ·  ' + e.out + ' layer' + (e.out === 1 ? '' : 's') + ' off the edge' : '');
    note.classList.toggle('warn', !!e);
  }
}

function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a || 1; }

/** Change the frame. Placements are fractions of it, so nothing has to be
    recomputed — the stack reflows by itself, which is the whole reason they are
    kept as fractions. What does have to happen is a resize of the stage canvas
    and a re-layout of the one element that is not drawn into it. */
/** The box, in frame fractions, that contains everything in the stack.
    Returns null when nothing reaches outside the frame. */
function stackExtent() {
  const f = frameSize();
  const W = f.w, H = f.h;
  let x0 = 0, y0 = 0, x1 = W, y1 = H, out = 0;
  layers.forEach(L => {
    if (!L.visible) return;
    const b = boxForLayer(L, W, H);
    const hw = (b.w != null ? b.w : b.s) / 2;
    const hh = (b.h != null ? b.h : b.s) / 2;
    // The turned box's own corners, so a tilted layer is measured by where it
    // really reaches rather than by its untilted width.
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const ex = Math.abs(hw * c) + Math.abs(hh * s);
    const ey = Math.abs(hw * s) + Math.abs(hh * c);
    const l = b.cx - ex, r = b.cx + ex, t = b.cy - ey, d = b.cy + ey;
    if (l < -0.5 || t < -0.5 || r > W + 0.5 || d > H + 0.5) out++;
    x0 = Math.min(x0, l); y0 = Math.min(y0, t);
    x1 = Math.max(x1, r); y1 = Math.max(y1, d);
  });
  if (!out) return null;
  return { out, x0, y0, x1, y1, w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/** Grow the frame until everything is inside it, WITHOUT the stack growing
    with it.

    Every placement here is a fraction of the frame, which is what makes a
    canvas change reflow instead of crop. It also means a naive "make the frame
    as big as the content" chases its own tail: double the frame and a layer at
    2.2 of the width is twice as wide as it was, so it is still hanging over the
    edge. The fix is to resize and re-place in one step — work out the new frame
    in the OLD frame's pixels, then rewrite every pose so each layer keeps the
    absolute size and position it already had. */
function fitCanvasToStack() {
  const e = stackExtent();
  const f = frameSize();
  if (!e) return false;
  const W0 = f.w, H0 = f.h;
  const W1 = Math.max(16, Math.min(8192, e.w)), H1 = Math.max(16, Math.min(8192, e.h));
  const remap = p => {
    const cx = p.x * W0 - e.x0, cy = p.y * H0 - e.y0;
    p.x = cx / W1;
    p.y = cy / H1;
    p.size = p.size * W0 / W1;
  };
  layers.forEach(L => { const p = layerPose(L); if (p) remap(p); });
  setCanvas('custom', W1, H1);
  const c = activeClip();
  if (c) { c.puppetPose = { ...puppetPose }; c.overlay = JSON.parse(JSON.stringify(overlay)); }
  bankLayers();
  syncPlateTransform();
  updateOverlayReadout();
  drawStage();
  return true;
}

/** This canvas is now the standing choice. Called from the controls only —
    `setCanvas` itself is used by "fit the stack" and by restoring a clip,
    neither of which is somebody choosing a format. */
function rememberCanvas() {
  canvasPreference = { ...canvasSetting };
}

function setCanvas(mode, w, h) {
  // "Fit the stack" is a measurement, not a mode: it works out a size now and
  // then behaves as a plain custom canvas, so adding another layer later does
  // not silently move the frame — and with it every placement, since every
  // placement is a fraction of the frame.
  if (mode === 'fit') {
    if (fitCanvasToStack()) return;              // it calls back in with 'custom'
    const f = frameSize();
    mode = 'custom'; w = f.w; h = f.h;
  }
  canvasSetting.mode = mode;
  if (w) canvasSetting.w = clamp(Math.round(w), 16, 8192);
  if (h) canvasSetting.h = clamp(Math.round(h), 16, 8192);
  const c = activeClip();
  if (c) c.canvas = { ...canvasSetting };
  syncCanvasUI();
  sizeStage();
  updateEstimates();
  renderLayerPanel();
}

function syncBoilUI() {
  const on = $('boilOn');
  if (!on) return;
  const n = boilLayerCount();
  on.checked = n.all > 0 && n.on === n.all;
  on.indeterminate = n.on > 0 && n.on < n.all;
  const box = $('boilControls');
  if (box) { box.hidden = false; box.classList.toggle('off', !n.on); }

  const fx = $('boilFx');
  if (fx && !fx.childElementCount) {
    BOIL_EFFECTS.forEach(([id, name]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.fx = id;
      b.textContent = name;
      b.onclick = () => {
        boil.effect = id;
        boilForget();
        const c = activeClip(); if (c) c.boil = { ...boil };
        syncBoilUI(); drawStage();
        if (boilAnyOn()) runBoilDemo();
      };
      fx.appendChild(b);
    });
  }
  if (fx) {
    fx.querySelectorAll('button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.fx === boil.effect)));
  }
  const fh = $('boilFxHint');
  const e = BOIL_EFFECTS.find(x => x[0] === boil.effect);
  if (fh) fh.textContent = e ? e[2] : '';

  const set = (id, v, out, suffix) => {
    const el = $(id), nf = $(id + 'Num'), o = $(out);
    if (el && document.activeElement !== el) el.value = v;
    if (nf && document.activeElement !== nf) nf.value = v;
    if (o) o.textContent = suffix == null ? '' : suffix;
  };
  set('boilIntensity', boil.intensity, 'boilIntensityOut', '±' + boilPixels() + 'px');
  set('boilGrain', boil.grain, 'boilGrainOut',
      boil.grain <= 3 ? 'slow bend' : boil.grain >= 8 ? 'fine tremble' : 'middling');
  set('boilCount', boil.count, 'boilCountOut', boil.count + ' drawings');
  set('boilFps', boil.fps, 'boilFpsOut',
      boil.fps + ' fps' + (state.fps ? ' · ' + boilOnNs() : ''));
  set('boilEdges', boil.edges, 'boilEdgesOut',
      boil.edges >= 70 ? 'lines only' : boil.edges <= 20 ? 'all over' : 'mixed');
  set('boilSeed', boil.seed, 'boilSeedOut', '');
  const pp = $('boilPingpong'); if (pp) pp.checked = !!boil.pingpong;
  const sm = $('boilSmooth'); if (sm) sm.checked = !!boil.smooth;

  const hint = $('boilHint');
  if (hint) {
    hint.textContent = !n.on
      ? 'The wobble of a line redrawn every few frames. Off on every layer — tick On, or tick it in one layer’s settings.'
      : 'On for ' + n.on + ' of ' + n.all + ' layer' + (n.all === 1 ? '' : 's') +
        ' · ' + boil.count + ' drawings at ' + boil.fps + ' fps' +
        (boil.pingpong ? ', back and forth' : '') +
        '. Paused it is one still drawing — press Try it to watch.';
  }
  const tb = $('boilTry');
  if (tb) tb.disabled = !state.frames.length;
}

/** "on twos" and friends, worked out from the cycle's rate against the clip's.
    It is the language animators actually use, and the two numbers on their own
    do not say it. */
function boilOnNs() {
  const r = (state.fps || 12) / clamp(boil.fps, 1, 30);
  if (Math.abs(r - Math.round(r)) > 0.08) return 'off the clip’s rate';
  const n = Math.max(1, Math.round(r));
  return 'on ' + (n === 1 ? 'ones' : n === 2 ? 'twos' : n === 3 ? 'threes' : n + 's');
}

/** Roughly how far the drawing moves, in the pixels a person is looking at.

    "Intensity 3" is a true description and tells you nothing. A number in
    screen pixels is the one that answers "will I see this", which was the
    actual question — and the preview draws at about two-thirds size, so a
    third of the effect is gone before it reaches the eye. */
function boilPixels() {
  const c = $('stage');
  if (!c) return 0;
  const shown = c.getBoundingClientRect().width || c.width;
  const amp = boilAmplitude(clamp(boil.intensity, 1, 12), c.width, c.height);
  return Math.max(1, Math.round(amp * (shown / c.width)));
}

/* Run the preview through a couple of seconds so the wobble can be SEEN.

   Reported three times as "I turn it on and nothing happens", and it was
   working every time. Three things were against it at once: the effect is a
   few pixels, the preview draws at about two-thirds size, and — the part that
   actually finished the job — the first drawing's offset can be almost
   nothing, so the very frame you are looking at when you tick the box may be
   the one that does not move.

   Telling people to press play was not enough, and a button they had to find
   was not enough. So ticking it on runs this. A per-frame effect has to be
   shown at the moment it is switched on; there is nowhere else to show it. */
let boilDemoRunning = 0;
/* A demo can be replaced by a newer one. Every slider release starts one, so
   two in quick succession is the normal case rather than an error — the second
   takes over and the first stops where it is, instead of being refused. */
let boilDemoToken = 0;
async function runBoilDemo() {
  if (!state.frames.length) return;
  const mine = ++boilDemoToken;
  if (boilDemoRunning > 0) cancelAnimationFrame(boilDemoRunning);
  if (!boilAnyOn()) boilSetAll(true);
  const btn = $('boilTry');
  const start = currentFrameIndex();
  const span = Math.max(8, Math.round(state.fps * 2.5));
  // Warp the drawings FIRST. A per-pixel warp is about forty milliseconds, so
  // playing straight away means the demo stutters through its first pass —
  // which is the pass someone judging "can I see this" is watching. Warming
  // the cache up front costs a second with a label on it and buys a smooth
  // demo and, afterwards, free playback.
  boilDemoRunning = -1;
  if (btn) btn.textContent = 'Boiling…';
  const warm = document.createElement('canvas');
  const st = $('stage');
  warm.width = st.width; warm.height = st.height;
  const wctx = warm.getContext('2d');
  for (let k = 0; k < span; k++) {
    const f = (start + k) % Math.max(1, state.frames.length);
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.clearRect(0, 0, warm.width, warm.height);
    compositeLayers(wctx, warm.width, warm.height, { frame: f, pose: poseAt(f) });
    if ((k & 3) === 3) {
      await new Promise(r => setTimeout(r, 0));
      // A newer demo has taken over — stop warming for this one.
      if (mine !== boilDemoToken) { warm.width = warm.height = 0; return; }
    }
  }
  warm.width = warm.height = 0;
  if (mine !== boilDemoToken) return;
  boilDemoRunning = 0;
  const t0 = performance.now();
  if (btn) btn.textContent = 'Watch…';
  boilDemoRunning = requestAnimationFrame(function step(now) {
    if (mine !== boilDemoToken) return;
    const k = Math.floor((now - t0) / 1000 * state.fps);
    if (k >= span) {
      demoFrame = null;
      boilDemoRunning = 0;
      if (btn) btn.textContent = 'Try it';
      drawStage();
      return;
    }
    demoFrame = (start + k) % Math.max(1, state.frames.length);
    drawStage();
    boilDemoRunning = requestAnimationFrame(step);
  });
}

function wireBoilControls() {
  const on = $('boilOn');
  if (!on) return;
  syncBoilUI();
  const touch = () => {
    const c = activeClip();
    if (c) c.boil = { ...boil };
    // The drawings were warped with the old settings, so they are now wrong.
    boilForget();
    syncBoilUI(); drawStage();
  };
  on.onchange = () => { boilSetAll(on.checked); if (on.checked) runBoilDemo(); };

  const tryBtn = $('boilTry');
  if (tryBtn) tryBtn.onclick = () => runBoilDemo();
  /* Letting go of a slider plays the result.

     The boil is a thing you cannot see on a paused frame — it IS the change
     between frames — so a number changed on a still picture tells you
     nothing, and "press Try it" after every nudge is a step nobody should
     have to remember. `change` fires when a slider is released and when a
     typed number is committed, which is exactly when you have finished
     saying what you meant. */
  const show = () => { if (boilAnyOn()) runBoilDemo(); };
  const num = (id, apply) => {
    [$(id), $(id + 'Num')].forEach(el => {
      if (!el) return;
      el.oninput = () => {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) { apply(v); touch(); }
      };
      el.addEventListener('change', show);
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    });
  };
  num('boilIntensity', v => { boil.intensity = clamp(Math.round(v), 1, 12); });
  num('boilGrain', v => { boil.grain = clamp(Math.round(v), 1, 10); });
  num('boilCount', v => { boil.count = clamp(Math.round(v), 2, 12); });
  num('boilFps', v => { boil.fps = clamp(Math.round(v), 2, 30); });
  num('boilEdges', v => { boil.edges = clamp(Math.round(v), 0, 100); });
  num('boilSeed', v => { boil.seed = clamp(Math.round(v), 1, 999); });
  const chk = (id, apply) => {
    const el = $(id);
    if (el) el.onchange = () => { apply(el.checked); touch(); show(); };
  };
  chk('boilPingpong', v => { boil.pingpong = v; });
  chk('boilSmooth', v => { boil.smooth = v; });
  const rr = $('boilReroll');
  if (rr) rr.onclick = () => {
    boil.seed = 1 + Math.floor(Math.random() * 999);
    touch();
    if (boilAnyOn()) runBoilDemo();
  };
}


function wireCanvasControls() {
  const sel = $('canvasPreset');
  if (!sel) return;
  syncCanvasUI();
  sel.onchange = () => {
    const v = sel.value;
    if (v === 'auto' || v === 'custom' || v === 'fit') { setCanvas(v); rememberCanvas(); return; }
    const m = /^(\d+)x(\d+)$/.exec(v);
    setCanvas('fixed', parseInt(m[1], 10), parseInt(m[2], 10));
    rememberCanvas();
  };
  const push = () => {
    const w = parseInt($('canvasW').value, 10), h = parseInt($('canvasH').value, 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w >= 16 && h >= 16) {
      setCanvas('custom', w, h);
      rememberCanvas();
    }
  };
  $('canvasW').addEventListener('change', push);
  $('canvasH').addEventListener('change', push);
}

/** The dropdown in the placement strip, so the layer under the handles can be
    changed without leaving the picture. */
function syncLayerSelect() {
  const sel = $('layerSelect');
  if (!sel) return;
  const want = [...layers].reverse();
  sel.innerHTML = '';
  want.forEach(L => {
    const o = document.createElement('option');
    o.value = L.id;
    o.textContent = (L.name || LAYER_KIND_LABEL[L.kind]) + (L.visible ? '' : ' (hidden)');
    sel.appendChild(o);
  });
  if (selectedLayerId) sel.value = selectedLayerId;
  sel.hidden = layers.length < 2;
}

/** Shadows are set on the context around a layer's draw, so every kind gets
    one from the same five numbers — all of them fractions of the frame, so a
    shadow looks the same at 512 as it does at 2048. */
function applyLayerShadow(ctx, L, W) {
  const sh = L && L.shadow;
  if (!sh || !sh.on) return false;
  const a = sh.alpha == null ? 0.5 : sh.alpha;
  if (a <= 0) return false;
  ctx.shadowColor = hexWithAlpha(sh.color || '#000000', a);
  ctx.shadowBlur = Math.max(0, sh.blur * W);
  ctx.shadowOffsetX = sh.dx * W;
  ctx.shadowOffsetY = sh.dy * W;
  return true;
}
function clearLayerShadow(ctx) {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}
function hexWithAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return 'rgba(0,0,0,' + a.toFixed(3) + ')';
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a.toFixed(3) + ')';
}

/* While the boil demo runs, the stage draws THIS frame instead of the
   playhead's. A demo that moved the playhead would scrub the waveform, fire
   the keyframe UI and leave the clip somewhere else when it finished; this
   touches nothing but the picture. */
let demoFrame = null;

function drawStage() {
  const c = $('stage'), ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  const fi = demoFrame == null ? currentFrameIndex()
           : clamp(demoFrame, 0, Math.max(0, state.frames.length - 1));
  const v = state.frames.length ? state.frames[fi].v : 'X';

  if (puppet.kind === 'video') syncPlate(playTime());

  if (state.video && !puppet.kind && !state.videoDecodable) {
    // a small banner, never a wash over the frame: the picture may be
    // showing perfectly well underneath
    const fs = Math.max(11, Math.round(W * 0.026));
    const pad = fs * 0.7, bh = fs * 2.1;
    ctx.save();
    ctx.fillStyle = 'rgba(20,24,29,.82)';
    ctx.fillRect(0, H - bh, W, bh);
    ctx.fillStyle = '#E3B7AC';
    ctx.textAlign = 'center';
    ctx.font = fs + 'px "Archivo",system-ui,sans-serif';
    ctx.fillText('No frames reached the canvas — the overlay export may come out blank', W / 2, H - bh + fs + pad * 0.2);
    ctx.restore();
  }

  if (hasPlate() || layers.some(L => L.kind !== 'mouth' && L.visible)) {
    // The stack, drawn by the same function the exports call. A pinned video
    // plate is skipped: it is the element under this canvas, and an image
    // plate is drawn here like anything else so that it can be reordered.
    compositeLayers(ctx, W, H, {
      frame: fi,
      pose: poseAt(fi),
      skipPinned: true,
      handles: !playing && demoFrame == null,
      drawPlate: cx => {
        const src = plateSource();
        const pl = plateLayer();
        if (!src || (pl && layerPinned(pl))) return;
        const pz = plateSize() || { w: W, h: H };
        const pw = puppetPose.size * W;
        const ph = pw * (pz.h / Math.max(1, pz.w));
        cx.save();
        cx.translate(puppetPose.x * W, puppetPose.y * H);
        cx.rotate(puppetPose.rot * Math.PI / 180);
        if (mirror.plate) cx.scale(-1, 1);
        cx.drawImage(src, -pw / 2, -ph / 2, pw, ph);
        cx.restore();
      }
    });
  } else {
    paintMouth(ctx, W, H, v, state.style);
  }

  if (!state.frames.length) {
    $('badgeFrame').textContent = '—';
    $('badgeViseme').textContent = '—';
    return;
  }
  $('badgeFrame').textContent = String(fi + 1).padStart(4, '0');
  // Which stretch is highlighted follows the playhead, but only when it has
  // actually moved to another one — repainting a list of selects on every
  // frame of playback would fight anyone using them.
  if (turnsRowAt(fi) !== turnsShownRow) { turnsShownRow = turnsRowAt(fi); renderTurns(); }
  $('badgeViseme').textContent = v;
  $('badgeViseme').title = VNAME[v];
}

/* Called with the canvas already translated to the box centre and rotated,
   so everything below is in the box's own frame: the handles turn with it,
   which is the only way the corner stays the corner. */
function drawOverlayHandles(ctx, b, W, H) {
  const g = overlayHandles(b, W, H);
  const h = g.h, hw = g.hw, hs = g.hs;
  const bw = b.w == null ? b.s : b.w, bh = b.h == null ? b.s : b.h;
  ctx.save();
  ctx.lineWidth = Math.max(1, W * 0.003);

  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeRect(-hw - 1, -h - 1, bw + 2, bh + 2);
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.setLineDash([W * 0.014, W * 0.010]);
  ctx.strokeRect(-hw, -h, bw, bh);
  ctx.setLineDash([]);

  // the stem out to the turn knob, dark under light so it reads on any picture
  ctx.beginPath();
  ctx.moveTo(0, g.turn.y < 0 ? -h : h);
  ctx.lineTo(0, g.turn.y);
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.lineWidth = Math.max(1, W * 0.003) * 2.2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = Math.max(1, W * 0.003);
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  // Four corners, any of which resizes. Reaching round a picture for one
  // particular corner is a thing you only do because the program made you.
  (g.corners || [g.scale]).forEach(q => {
    ctx.fillRect(q.x - hs / 2, q.y - hs / 2, hs, hs);
    ctx.strokeRect(q.x - hs / 2, q.y - hs / 2, hs, hs);
  });

  ctx.beginPath();                                                 // knob: angle
  ctx.arc(g.turn.x, g.turn.y, hs * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/* The blur control only means anything over a picture with a mouth on it.
   Rather than show a dead slider, the row goes away until there is one. */
/** Push the blur values into the controls. Needed when a clip is opened and
    brings its own settings with it. */
function syncPatchUI() {
  $('patchOn').checked = patch.on;
  $('patchBlur').value = Math.round(patch.blur * 100);
  $('patchCover').value = Math.round(patch.cover * 100);
}

function overlayToolsVisible(show) {
  $('overlayTools').hidden = !show;
  $('patchRow').hidden = !show;
  // The rail just got taller or shorter, and the sheet pane is sized from it.
  if (typeof sizeSheetPane === 'function') sizeSheetPane();
}

/* ------------------------------------------------------------------ tabs

   The deck above stays put; only this strip changes. Canvases inside a hidden
   pane have no layout, so anything drawn while it was away comes back the
   wrong size — the chart is rebuilt on the way in. */
/* Four tabs, and the fourth is a gear at the other end of the strip.

   It was five: Input, Analysis, Mouth, Layers, Export. Layers has folded into
   Input, because the stack sits on the puppet and "put a picture behind the
   character" should not be a trip between two screens; Analysis has become
   Settings and moved to the far right, because it is set once and left, which
   is not what the first tab in a row is for. */
const TABS = ['inputs', 'mouth', 'export', 'settings'];
let activeTab = 'inputs';

function showTab(name) {
  if (!TABS.includes(name)) return;
  activeTab = name;
  TABS.forEach(t => {
    const on = t === name;
    $('tab-' + t).hidden = !on;
    const b = $('tabBtn-' + t);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  if (name === 'mouth') { buildStyleChips(); buildLipChips(); buildChart(); }
  // The rows carry live thumbnails and live numbers, so they are rebuilt on
  // the way in rather than kept up to date while nobody is looking at them.
  if (name === 'inputs') renderLayerPanel();
  // The sheet is not in here any more — it lives under the stage, in view
  // whichever tab is open, which is the whole point of the two-column layout.
  // Changing tabs still changes this column's width on some screens, so the
  // sheet is re-measured on the way in rather than left a sliver.
  sizeSheetPane(); layoutSheet(); drawSheet(); drawOverview();
}

/** One listener, in the capture phase, so nothing can swallow it on the way
    down. Cheap: a closest() per press. */
function wireSurfaceTracking() {
  const claim = el => {
    if (!el || !el.closest) return;
    if (el.closest('#trimBar, #overview')) lastSurface = 'timeline';
    else if (el.closest('#xsScroll, .sheet-foot')) lastSurface = 'sheet';
    else if (el.closest('#stageWrap, .layerlist, #layerEdit')) lastSurface = 'stage';
  };
  // Focus as well as pointers: the sheet is a focusable widget and arriving at
  // it by keyboard is arriving at it. Without this, pressing a button on the
  // trim bar and then working in the sheet left ⌘Z still aimed at the
  // timeline — which is how a key meant for a mouth shape re-cut a clip.
  document.addEventListener('pointerdown', e => claim(e.target), true);
  document.addEventListener('focusin', e => claim(e.target), true);
}

function wireTabs() {
  TABS.forEach(t => {
    $('tabBtn-' + t).addEventListener('click', () => showTab(t));
  });
  // Left/right arrows walk the strip, which is what a tablist is expected to do.
  $('tabBtn-inputs').parentElement.addEventListener('keydown', e => {
    const i = TABS.indexOf(activeTab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      showTab(n);
      $('tabBtn-' + n).focus();
    }
  });
  // Always open on Inputs. The tab is not remembered: a fresh visit landing
  // on Export — the end of the job, with nothing loaded to export — was the
  // reason. The work starts at the left, and the first question is what you
  // are working on.
  showTab('inputs');
  wireSurfaceTracking();
}

/* ------------------------------------------------------- export info panels

   One handler for all eight cards, delegated, because the cards are markup and
   nothing about this needs to know which card it is. One panel open at a time:
   two panels over a three-across grid overlap each other, and the second click
   is nearly always "no, the other one". */
function closeExpInfo(except) {
  document.querySelectorAll('.expinfo').forEach(p => {
    if (p === except) return;
    p.hidden = true;
    const b = document.querySelector('[aria-controls="' + p.id + '"]');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}

function wireExpInfo() {
  document.addEventListener('click', e => {
    const btn = e.target.closest ? e.target.closest('.infobtn') : null;
    if (btn) {
      const pane = $(btn.getAttribute('aria-controls'));
      if (!pane) return;
      const open = pane.hidden;
      closeExpInfo(open ? pane : null);
      pane.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      return;
    }
    // A click anywhere else closes it — including on the card's own controls,
    // which is the point: the panel is covering them.
    if (!(e.target.closest && e.target.closest('.expinfo'))) closeExpInfo(null);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.expinfo:not([hidden])');
    if (!open) return;
    const btn = document.querySelector('[aria-controls="' + open.id + '"]');
    closeExpInfo(null);
    if (btn) btn.focus();
  });
}

/** Put one value into a slider and its number field at once, without fighting
    whichever of the two is being used. `decimals` is for the field only. */
function pairValue(rangeId, numId, value, limits, decimals) {
  const r = $(rangeId), n = $(numId);
  const lo = limits[0], hi = limits[1];
  const v = clamp(value, lo, hi);
  if (r) {
    r.min = lo; r.max = hi;
    if (document.activeElement !== r) r.value = String(Math.round(v));
  }
  if (n) {
    n.min = lo; n.max = hi;
    // Never while it has focus: rewriting a field mid-type turns "-1" into
    // "-1" rounded to something, and the caret jumps to the end.
    if (document.activeElement !== n) {
      const d = decimals == null ? 0 : decimals;
      n.value = d ? String(+v.toFixed(d)) : String(Math.round(v));
    }
  }
}

function updateOverlayReadout() {
  // Both readouts belong to whichever layer the handles are on, or they report
  // the mouth's size while you are dragging the picture.
  const o = activePose();
  $('overlaySize').textContent = Math.round(o.size * 100) + '%';
  // Never overwrite a control while it has focus — a slider being dragged is
  // mid-gesture, and writing to it fights the drag.
  // The useful range differs by kind: the puppet starts at 1 and mostly goes
  // down, the mouth is never bigger than the frame and a half. One slider for
  // all of them has to take the widest, and read the same as the drag limits
  // in the pointer handler or the two disagree at the ends.
  const L = selectedLayer();
  const lim = activeIsPlate() ? [8, 400] : (L && L.kind === 'mouth') ? [4, 160] : [2, 400];
  // A tenth of a percent in the field, whole percents on the slider: the field
  // is the one you reach for when the slider is not fine enough, so rounding
  // it to the slider's step would defeat the point of having it.
  pairValue('overlaySizeRange', 'overlaySizeNum', o.size * 100, lim, 1);
  pairValue('overlayAngle', 'overlayAngleNum', o.rot, [-180, 180], 1);
  const del = $('overlayDelete');
  if (del) {
    const can = !!L && L.kind !== 'mouth' && !(L.kind === 'plate' && layerPinned(L));
    del.disabled = !can;
    del.title = !L ? 'Nothing selected'
      : L.kind === 'mouth' ? 'The mouth is what this page is for — it cannot be removed'
      : 'Remove ' + (L.name || 'this layer');
  }
  const hint = $('placeHint');
  if (hint) {
    const L = selectedLayer();
    hint.textContent = !L || L.kind === 'mouth'
      ? 'Drag to place · corner sizes · knob turns'
      : 'Drag ' + (L.name || 'the layer') + ' · corner resizes · knob tilts';
  }
  syncLayerSelect();
}

/** Kept for the callers that still speak of two layers — the puppet and the
    mouth — which is now just a way of naming two entries in the stack. */
function setEditLayer(which) {
  const L = which === 'puppet' && hasPlate() ? plateLayer() : mouthLayer();
  if (L) selectLayer(L.id);
  else { updateOverlayReadout(); drawStage(); }
}

/* ---- reading a script along the sheet -------------------------------------

   Nothing here transcribes: Rhubarb's recogniser is running on the small phone
   model, and the port only hands back mouth shapes. What this does is align a
   script you already have — phrases are found from the silences the analyser
   already marked, and words are spread across them by syllable count. Enough
   to find your place on the sheet; not a transcription.
--------------------------------------------------------------------------- */

function speechPhrases() {
  const f = state.frames, raw = [];
  let i = 0;
  while (i < f.length) {
    while (i < f.length && f[i].v === 'X') i++;
    if (i >= f.length) break;
    let j = i;
    while (j < f.length && f[j].v !== 'X') j++;
    raw.push({ a: i, b: j - 1 });
    i = j;
  }
  const gap = Math.max(1, Math.round(0.24 * state.fps));
  const merged = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && p.a - last.b - 1 <= gap) last.b = p.b;
    else merged.push({ a: p.a, b: p.b });
  }
  return merged.filter(p => p.b - p.a + 1 >= 2);
}

function syllables(word) {
  const s = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 1;
  const m = s.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, m ? m.length : 1);
}

function alignScript(text) {
  const words = text.split(/\s+/).map(w => w.trim()).filter(Boolean);
  const phrases = speechPhrases();
  state.script = [];
  if (!words.length || !phrases.length) return { words: words.length, phrases: phrases.length };

  const totalSyl = words.reduce((a, w) => a + syllables(w), 0);
  const totalFrames = phrases.reduce((a, p) => a + (p.b - p.a + 1), 0);
  let w = 0;

  phrases.forEach((p, pi) => {
    const frames = p.b - p.a + 1;
    const isLast = pi === phrases.length - 1;
    let budget = isLast ? Infinity : Math.max(1, Math.round(frames / totalFrames * totalSyl));
    const take = [];
    let used = 0;
    while (w < words.length && (used < budget || !take.length)) {
      const word = words[w++];
      take.push(word);
      used += syllables(word);
      // a sentence ending is a better place to break than an exact syllable count
      if (!isLast && used >= budget * 0.7 && /[.!?]["')\]]?$/.test(word)) break;
    }
    if (!take.length) return;
    // Lay the words out on cumulative syllables rather than per-word rounding,
    // so they always tile the phrase in order and never run past its end.
    const sylSum = take.reduce((a, x) => a + syllables(x), 0);
    let at = p.a, acc = 0;
    take.forEach((word, k) => {
      acc += syllables(word);
      const end = k === take.length - 1
        ? p.b
        : p.a + Math.round(frames * acc / sylSum) - 1;
      const b = clamp(end, at, p.b);
      state.script.push({ word, a: at, b });
      at = Math.min(p.b, b + 1);
    });
  });
  return { words: words.length, phrases: phrases.length, crowded: state.script.some(s => s.b <= s.a) && words.length > totalFrames };
}

/* ----------------------------------------------------- 6. the exposure sheet */

/* --- the sheet opens at the height of the preview beside it -----------------

   Asked for, and right: the sheet tab replaced a panel that used to sit next to
   the preview, so opening at some other height makes the page jump on every tab
   change. It is a MINIMUM rather than a fixed height — a long take, or the
   script panel underneath, still pushes past it.

   It has to be measured rather than written in CSS, because the preview is in
   the deck and the sheet is in the workspace: two separate containers with no
   CSS relationship to inherit. The number goes on the root as a custom property
   so the stylesheet still owns what to do with it. */
function sizeSheetPane() {
  // The sheet is in the same column as the stage now, so its width comes from
  // the stylesheet and there is nothing to measure across containers. What is
  // left is the canvases: a width change has to reach them, because a canvas
  // keeps painting at its backing-store size until it is told otherwise.
  const sp = document.querySelector('.sheetwrap .sheet-panel');
  if (!sp) return;
  const h = Math.round(sp.getBoundingClientRect().height);
  if (h > 80) document.documentElement.style.setProperty('--preview-h', h + 'px');
}

const CW = 17;                       // px per frame in the detail strip
function layoutSheet() {
  const sp = $('xsSpacer');
  sp.style.width = Math.max($('xsScroll').clientWidth, state.frames.length * CW) + 'px';
  const c = $('xsheet');
  const sc = $('xsScroll');
  const w = sc.clientWidth, hpx = Math.max(96, sc.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.round(hpx * dpr);
  c.style.width = w + 'px';
  c.style.height = hpx + 'px';
}

/* Cleared frames get the transparency checker every paint program uses, so an
   erased run reads as "nothing here" rather than as one more coloured shape. */
let checkerPattern = null, checkerKey = '';
function restPattern(ctx, a, b) {
  const key = a + b;
  if (checkerPattern && checkerKey === key) return checkerPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 10;
  const x = c.getContext('2d');
  x.fillStyle = a; x.fillRect(0, 0, 10, 10);
  x.fillStyle = b; x.fillRect(0, 0, 5, 5); x.fillRect(5, 5, 5, 5);
  checkerPattern = ctx.createPattern(c, 'repeat');
  checkerKey = key;
  return checkerPattern;
}

/* The intake sits at the top of the preview panel and has two shapes: a drop
   zone before a file arrives, and a row of file facts after. One place
   decides, so the two can never disagree. */
function setLoadedUI(on) {
  $('loaded').classList.toggle('on', on);
  $('intake').classList.toggle('has-file', on);
  // The script only means anything against audio, so it turns up with the file.
  $('scriptBar').hidden = !on;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ---------------------------------------------------------------- theming
   The palette is entirely CSS custom properties, so switching is one
   attribute on <html> — but the canvases sample those properties with css()
   at draw time, so they hold the old colours until told to repaint, and the
   checker pattern is memoised from --surface-2/--surface-3 and has to go. */
const THEME_KEY = 'mouthchart.theme';
// 'auto' only until the first click. Nothing in the interface says "auto" any
// more — the toggle has two positions — but the state is still needed, because
// a first visit should take the system setting and follow it if the system
// changes under us, and the click is what ends that.
let themeChoice = 'auto';

function repaintTheme() {
  checkerPattern = null; checkerKey = '';
  drawSheet();
  drawOverview();
}

function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch (e) { return false; }
}

function effectiveTheme() {
  return themeChoice === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : themeChoice;
}

function syncThemeToggle() {
  const b = $('themeToggle');
  if (!b) return;
  const dark = effectiveTheme() === 'dark';
  const sun = b.querySelector('.t-sun'), moon = b.querySelector('.t-moon');
  // style.display rather than the hidden attribute: these are SVG elements,
  // and display is the one thing every engine honours on them.
  if (sun) sun.style.display = dark ? 'none' : 'block';
  if (moon) moon.style.display = dark ? 'block' : 'none';
  const label = 'Switch to ' + (dark ? 'light' : 'dark') + ' appearance';
  b.setAttribute('title', label);
  b.setAttribute('aria-label', label);
}

function applyTheme(choice, repaint) {
  themeChoice = (choice === 'light' || choice === 'dark') ? choice : 'auto';
  if (themeChoice === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', themeChoice);
  syncThemeToggle();
  if (repaint) repaintTheme();
}

function initTheme() {
  let saved = 'auto';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') saved = v;
  } catch (e) {}
  applyTheme(saved, false);

  const btn = $('themeToggle');
  if (btn) btn.addEventListener('click', () => {
    // From wherever we actually are, not from the stored choice — on a first
    // visit under a dark system the stored choice is 'auto', and clicking has
    // to go to light, not to dark again.
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true);
    try { localStorage.setItem(THEME_KEY, themeChoice); } catch (err) {}
  });
}

function drawSheet() {
  const c = $('xsheet'), ctx = c.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = c.width / dpr, H = c.height / dpr;
  ctx.clearRect(0, 0, W, H);
  const ink = css('--ink'), ink2 = css('--ink-2'), ink3 = css('--ink-3'),
        line = css('--line-soft'), sig = css('--signal');
  const checker = restPattern(ctx, css('--surface-2'), css('--surface-3'));

  if (!state.frames.length) {
    ctx.fillStyle = ink3;
    ctx.font = '12px "DM Mono",monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Load a voice track to build the sheet', W / 2, H / 2 + 4);
    return;
  }

  const off = $('xsScroll').scrollLeft;
  const first = Math.max(0, Math.floor(off / CW) - 1);
  const last = Math.min(state.frames.length - 1, Math.ceil((off + W) / CW) + 1);
  const hasScript = state.script && state.script.length;
  const wordBand = hasScript ? 26 : 0;
  const numH = 20, cellY = 22, cellH = Math.max(40, H - cellY - 16 - wordBand);

  ctx.textAlign = 'center';
  for (let i = first; i <= last; i++) {
    const x = i * CW - off;
    const f = state.frames[i];

    if (i % 4 === 0) {
      ctx.fillStyle = i % 12 === 0 ? ink2 : ink3;
      ctx.font = (i % 12 === 0 ? '500 ' : '') + '9.5px "DM Mono",monospace';
      ctx.fillText(String(i + 1), x + CW / 2, 13);
    }
    const isNew = i === 0 || state.frames[i - 1].v !== f.v;
    if (f.v === 'X') {
      ctx.fillStyle = checker;
      ctx.fillRect(x + 1, cellY, CW - 2, cellH);
    } else {
      ctx.fillStyle = VCOL[f.v];
      ctx.globalAlpha = isNew ? 1 : 0.62;
      ctx.fillRect(x + 1, cellY, CW - 2, cellH);
      ctx.globalAlpha = 1;
    }

    if (isNew) {
      ctx.font = '600 12px "DM Mono",monospace';
      ctx.globalAlpha = f.v === 'X' ? 0.7 : 0.96;
      ctx.fillStyle = f.v === 'X' ? ink3 : '#FFFFFF';
      ctx.fillText(f.v, x + CW / 2, cellY + Math.min(30, cellH * 0.62));
      ctx.globalAlpha = 1;
    }
    if (f.edited) {
      ctx.fillStyle = sig;
      ctx.beginPath();
      ctx.arc(x + CW / 2, cellY + cellH + 8, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (i % 12 === 0) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + .5, numH); ctx.lineTo(x + .5, cellY + cellH); ctx.stroke();
    }
  }

  if (hasScript) {
    const y = cellY + cellH + 6;
    ctx.textAlign = 'center';
    ctx.font = '11px "Archivo",system-ui,sans-serif';
    for (const s of state.script) {
      const x0 = s.a * CW - off, w = (s.b - s.a + 1) * CW;
      if (x0 + w < 0 || x0 > W) continue;
      ctx.fillStyle = css('--surface-3');
      ctx.fillRect(x0 + 1, y, w - 2, wordBand - 8);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0 + 2, y, w - 4, wordBand - 8); ctx.clip();
      ctx.fillStyle = ink2;
      ctx.fillText(s.word, x0 + w / 2, y + wordBand - 15);
      ctx.restore();
    }
  }

  // selection marquee
  const [sa, sb] = selRange();
  const mx = sa * CW - off, mw = (sb - sa + 1) * CW;
  if (mx + mw > 0 && mx < W) {
    ctx.save();
    ctx.fillStyle = css('--accent');
    ctx.globalAlpha = 0.14;
    ctx.fillRect(mx + 1, cellY, mw - 2, cellH);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(mx + 1, cellY - 1, mw - 2, cellH + 2);
    ctx.restore();
  }
  // playhead
  if (state.buffer) {
    const px = playTime() * state.fps * CW - off;
    if (px > -2 && px < W + 2) {
      ctx.strokeStyle = sig;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H - 12); ctx.stroke();
    }
  }
  ctx.fillStyle = ink;
}

const OV_H = 84;

/** What the overview is a picture of. ONE time base — seconds into the source
    file — with the kept range marked out inside it.

    This is the resolution of a tension that used to be settled by having two
    separate widgets: the trim strip showed the whole source, the overview
    showed the trimmed clip counting from zero, and mixing them was avoided on
    the grounds that two time bases in one widget is how sync bugs start. That
    is still true; the way out is not two widgets but one base. Source seconds
    win because trimming has to be able to reach the audio it has cut off, and
    clip-relative time cannot name it. Everything drawn in clip time — the
    viseme band, the keys, the playhead — is pushed through `at()` on the way
    in, and there is exactly one conversion, in one place.

    Untrimmed, `a` is 0 and `b` is the whole file, so the picture is identical
    to the one this widget drew before. */
function ovSpan() {
  const clip = activeClip();
  const dur = (clip && clip.srcDuration) || (state.buffer ? state.buffer.duration : 0);
  if (!dur) return null;
  const a = clip ? (clip.in || 0) : 0;
  const b = clip ? (clip.out == null ? dur : clip.out) : dur;
  return { clip, dur, a, b };
}

/** Seconds into the source -> pixels across the overview, and back. */
const ovX = (sp, t, W) => t / sp.dur * W;
const ovT = (sp, x, W) => clamp(x / W, 0, 1) * sp.dur;

function drawOverview() {
  const c = $('overview'), ctx = c.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 800;
  c.width = Math.round(w * dpr); c.height = Math.round(OV_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = w, H = OV_H;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = css('--surface-2');
  roundRect(ctx, 0, 0, W, H, 7); ctx.fill();
  const sp = ovSpan();
  if (!sp || !state.mono) return;
  // clip seconds -> pixels. With a bit dropped out of the middle the clip no
  // longer runs at a constant offset from the source, so this goes through the
  // same map playback does rather than adding the in point.
  const gappy = !!(sp.clip && (sp.clip.drops || []).length);
  const at = tClip => ovX(sp, gappy ? clipToSrc(sp.clip, tClip) : sp.a + tClip, W);
  const x0 = ovX(sp, sp.a, W), x1 = ovX(sp, sp.b, W);

  const bandH = 10, waveH = H - bandH - 8;
  const midY = 5 + waveH / 2;
  ctx.strokeStyle = css('--ink-3');
  ctx.globalAlpha = .85;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // The source's own peaks where they exist, because the trimmed-off parts have
  // to be visible to be trimmed back in; state.mono only holds what was kept.
  const pk = sp.clip && sp.clip.peaks;
  if (pk) {
    const n = pk.length / 2;
    for (let x = 0; x < W; x++) {
      const i = Math.min(n - 1, Math.floor(x / W * n));
      ctx.moveTo(x + .5, midY - pk[i * 2 + 1] * waveH / 2);
      ctx.lineTo(x + .5, midY - pk[i * 2] * waveH / 2);
    }
  } else {
    const n = state.mono.length;
    const lo = Math.max(0, Math.floor(x0)), hi = Math.min(W, Math.ceil(x1));
    for (let x = lo; x < hi; x++) {
      const f0 = (x - x0) / Math.max(1, x1 - x0), f1 = (x + 1 - x0) / Math.max(1, x1 - x0);
      const a = clamp(Math.floor(f0 * n), 0, n - 1), b = clamp(Math.floor(f1 * n), 0, n);
      let mn = 0, mx = 0;
      for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 220))) {
        const v = state.mono[i];
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      ctx.moveTo(x + .5, midY - mx * waveH / 2);
      ctx.lineTo(x + .5, midY - mn * waveH / 2);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (state.frames.length) {
    const y = H - bandH - 3;
    const span = Math.max(1, x1 - x0);
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      // Which frame is under this pixel: straight through the span when the
      // clip is contiguous, through the source map when it is not — otherwise
      // the band slides against the waveform it is meant to describe.
      let i;
      if (gappy) {
        const ts = ovT(sp, x, W);
        if (dropAt(sp.clip, ts)) continue;
        i = clamp(Math.floor(srcToClip(sp.clip, ts) * state.fps), 0, state.frames.length - 1);
      } else {
        i = clamp(Math.floor((x - x0) / span * state.frames.length), 0, state.frames.length - 1);
      }
      const v = state.frames[i].v;
      ctx.fillStyle = VCOL[v];
      ctx.globalAlpha = v === 'X' ? .28 : 1;
      ctx.fillRect(x, y, 1, bandH);
    }
    ctx.globalAlpha = 1;
  }
  // What is being thrown away — the trimmed ends and the dropped middles get
  // the same shading, because they mean the same thing: not in the clip.
  //
  // "Not in the clip" is not the same as "gone", though, and treating them as
  // one is what made a split look like a deletion. Only the stretches NO piece
  // holds get the heavy shading; a neighbouring piece gets a light wash and
  // its name, because it is still here and one press away.
  const fam = fileFamily(sp.clip);
  ctx.fillStyle = css('--surface-3');
  ctx.globalAlpha = .78;
  let cursor = 0;
  fam.forEach(c => {
    const a = ovX(sp, c.in || 0, W), b = ovX(sp, clipOut(c), W);
    if (a > cursor) ctx.fillRect(cursor, 0, a - cursor, H);
    cursor = Math.max(cursor, b);
  });
  if (cursor < W) ctx.fillRect(cursor, 0, W - cursor, H);
  ctx.globalAlpha = .5;
  fam.forEach(c => {
    if (c === sp.clip) return;
    const a = ovX(sp, c.in || 0, W);
    ctx.fillRect(a, 0, ovX(sp, clipOut(c), W) - a, H);
  });
  const drops = (sp.clip && sp.clip.drops || []);
  drops.forEach(d => {
    const dx = ovX(sp, d[0], W), dw = ovX(sp, d[1], W) - dx;
    ctx.fillRect(dx, 0, dw, H);
  });
  ctx.globalAlpha = 1;
  // A dropped bit is struck through, so it reads as deliberately removed rather
  // than as a quiet passage, and says where to press to bring it back.
  drops.forEach(d => {
    const dx = ovX(sp, d[0], W), dw = ovX(sp, d[1], W) - dx;
    ctx.strokeStyle = css('--signal');
    ctx.globalAlpha = .55;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(dx + 2, H / 2); ctx.lineTo(dx + dw - 2, H / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
  if (sp.clip && sp.clip.srcDuration) {
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, 1, Math.max(2, x1 - x0 - 2), H - 2);
    ctx.fillStyle = css('--accent');
    ctx.fillRect(x0, 0, 3, H);
    ctx.fillRect(x1 - 3, 0, 3, H);
  }

  // The cut list: a name on every piece, and a division where two of them
  // meet. The division is drawn as a pair of shoulders rather than a line so
  // it reads as a thing to take hold of, which is what it is.
  if (fam.length > 1) {
    ctx.font = '600 10px ' + (css('--mono') || 'ui-monospace, monospace');
    ctx.textBaseline = 'alphabetic';
    fam.forEach(c => {
      const a = ovX(sp, c.in || 0, W), b = ovX(sp, clipOut(c), W);
      if (b - a < 26) return;                    // no room to say anything
      const live = c === sp.clip;
      ctx.save();
      ctx.beginPath(); ctx.rect(a + 3, 0, b - a - 6, H); ctx.clip();
      // Just under the lane the divisions live in, on a plate of its own: at
      // the foot it sat on the viseme band, which is the one row in here that
      // is already saying something.
      const ty = MARK_LANE + 12;
      const tw2 = ctx.measureText(c.name).width;
      ctx.fillStyle = css('--surface');
      ctx.globalAlpha = .72;
      roundRect(ctx, a + 4, ty - 10, tw2 + 8, 13, 3); ctx.fill();
      ctx.fillStyle = live ? css('--accent') : css('--ink-2');
      ctx.globalAlpha = live ? 1 : .9;
      ctx.fillText(c.name, a + 8, ty);
      ctx.restore();
    });
    fileEdges(sp.clip).forEach(e => {
      const ex = ovX(sp, e.t, W);
      ctx.fillStyle = css('--ink-2');
      ctx.globalAlpha = .9;
      ctx.fillRect(ex - 1, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(ex - EDGE_GRAB_PX, 0);
      ctx.lineTo(ex - 2, MARK_LANE);
      ctx.lineTo(ex + 2, MARK_LANE);
      ctx.lineTo(ex + EDGE_GRAB_PX, 0);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  // Markers. The flag at the top is the grab handle — see MARK_LANE — so it is
  // drawn big enough to aim at, and the line below it is a guide rather than a
  // target.
  (sp.clip && sp.clip.marks || []).forEach(t => {
    const mx = ovX(sp, t, W);
    ctx.fillStyle = css('--good');
    ctx.fillRect(mx - 1, MARK_LANE - 2, 2, H - MARK_LANE + 2);
    ctx.beginPath();
    ctx.moveTo(mx - MARK_GRAB_PX, 0);
    ctx.lineTo(mx + MARK_GRAB_PX, 0);
    ctx.lineTo(mx, MARK_LANE);
    ctx.closePath(); ctx.fill();
  });

  if (state.buffer) {
    const px = at(playTime());
    ctx.strokeStyle = css('--signal');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }
}

/* Selection is a range: an anchor plus a moving end, the way a marquee works
   in a paint program. A single click collapses it to one frame. */
function selRange() {
  const a = clamp(state.sel, 0, Math.max(0, state.frames.length - 1));
  const b = clamp(state.selEnd, 0, Math.max(0, state.frames.length - 1));
  return a <= b ? [a, b] : [b, a];
}

function setSelection(anchor, end, scroll) {
  if (!state.frames.length) return;
  const n = state.frames.length;
  state.sel = clamp(anchor, 0, n - 1);
  state.selEnd = clamp(end === undefined ? anchor : end, 0, n - 1);
  if (scroll) {
    const sc = $('xsScroll');
    const x = state.selEnd * CW;
    if (x < sc.scrollLeft + 20) sc.scrollLeft = x - 20;
    else if (x > sc.scrollLeft + sc.clientWidth - CW - 20) sc.scrollLeft = x - sc.clientWidth + CW + 20;
  }
  if (!playing) seekTo(selRange()[0] / state.fps);
  updateSelReadout();
  drawSheet(); drawStage(); drawOverview();
}

function selectFrame(i, scroll) { setSelection(i, i, scroll); }

function updateSelReadout() {
  const el = $('selInfo');
  if (!state.frames.length) { el.textContent = '—'; return; }
  const [a, b] = selRange();
  el.textContent = a === b
    ? 'Frame ' + (a + 1)
    : 'Frames ' + (a + 1) + '–' + (b + 1) + ' · ' + (b - a + 1);
  const edits = state.frames.filter(f => f.edited).length;
  $('clearEdits').disabled = !edits;
  $('eraseBtn').disabled = !state.frames.length;
}

/* ---- undo ----
   Erasing a run is destructive, so every mutation snapshots the two things a
   snapshot needs: the shape per frame and which frames the user has touched. */
const history = { stack: [], at: -1 };

function snapshot() {
  return {
    v: state.frames.map(f => f.v).join(''),
    e: Uint8Array.from(state.frames, f => f.edited ? 1 : 0)
  };
}

function resetHistory() {
  history.stack = state.frames.length ? [Object.assign(snapshot(), { at: 0 })] : [];
  history.at = history.stack.length - 1;
  syncHistoryButtons();
}

function pushHistory() {
  if (!state.frames.length) return;
  history.stack = history.stack.slice(0, history.at + 1);
  history.stack.push(Object.assign(snapshot(), { at: ++editClock }));
  if (history.stack.length > 60) history.stack.shift();
  history.at = history.stack.length - 1;
  syncHistoryButtons();
}

function applySnapshot(s) {
  for (let i = 0; i < state.frames.length && i < s.v.length; i++) {
    state.frames[i].v = s.v[i];
    state.frames[i].edited = !!s.e[i];
  }
  state.dirty = state.frames.some(f => f.edited);
  updateSelReadout();
  drawSheet(); drawStage(); drawOverview();
}

function undo() {
  if (history.at <= 0) return;
  history.at--;
  applySnapshot(history.stack[history.at]);
  syncHistoryButtons();
}

function redo() {
  if (history.at >= history.stack.length - 1) return;
  history.at++;
  applySnapshot(history.stack[history.at]);
  syncHistoryButtons();
}

function syncHistoryButtons() {
  $('undoBtn').disabled = history.at <= 0;
  $('redoBtn').disabled = history.at >= history.stack.length - 1;
}

/** Apply a shape across the selection. `v` of 'X' is what the eraser writes. */
function setViseme(v, range) {
  if (!state.frames.length) return;
  const [a, b] = range || selRange();
  for (let i = a; i <= b; i++) {
    if (!state.frames[i]) continue;
    state.frames[i].v = v;
    state.frames[i].edited = true;
  }
  state.dirty = true;
  pushHistory();
  updateSelReadout();
  drawSheet(); drawStage(); drawOverview();
}

function eraseSelection() {
  const [a, b] = selRange();
  setViseme('X');
  toast((b - a + 1) === 1
    ? 'Frame ' + (a + 1) + ' cleared to rest.'
    : 'Frames ' + (a + 1) + '–' + (b + 1) + ' cleared to rest.', 2200);
}

/* ------------------------------------------------------------- 7. transport */

let playing = false, rafId = 0;

function playTime() {
  if (!state.buffer) return 0;
  const c = activeClip();
  // No drops: the old subtraction, to the letter. With drops the element is
  // still playing the whole file, so where it is has to be read through the
  // piecewise map rather than by taking a constant off.
  if (!c || !(c.drops || []).length) {
    return clamp((player.currentTime || 0) - trimIn(), 0, state.buffer.duration);
  }
  return clamp(srcToClip(c, player.currentTime || 0), 0, state.buffer.duration);
}

function setPlayIcon(on) {
  $('playIcon').innerHTML = on
    ? '<rect x="7" y="5.5" width="3.5" height="13" rx="1"/><rect x="13.5" y="5.5" width="3.5" height="13" rx="1"/>'
    : '<path d="M8 5.5v13l11-6.5z"/>';
}

function tick() {
  if (!playing) return;
  // The element is playing the whole file, dropped bits and all, so playback
  // has to step over them. A seek mid-play makes the picture hitch, which is
  // exactly what a cut looks like in any editor's preview — the alternative is
  // hearing material the clip no longer contains.
  const clip = activeClip();
  if (clip && (clip.drops || []).length) {
    const hole = dropAt(clip, player.currentTime || 0);
    if (hole) { try { player.currentTime = hole[1]; } catch (e) {} }
  }
  const t = playTime();
  // The out point is ours to enforce.
  if (isTrimmed() && t >= state.buffer.duration - 0.005) {
    if (looping) { seekTo(0); }
    else {
      player.pause(); stopPlayback(false);
      // A trimmed line ends here rather than at the file's end, so this is
      // where "play all" is told to move on.
      playAllLineEnded();
      return;
    }
  }
  $('tNow').textContent = fmtTime(t);
  drawStage(); drawOverview();
  const sc = $('xsScroll');
  const x = t * state.fps * CW;
  if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth * 0.35;
  drawSheet();
  rafId = requestAnimationFrame(tick);
}

async function togglePlay() {
  if (!state.buffer) return;
  if (playing) { player.pause(); return; }
  try {
    if (playTime() >= state.buffer.duration - 0.02) seekTo(0);
    await player.play();
  } catch (e) {
    console.error(e);
    toast('The browser refused to start playback: ' + (e.name || e), 4200);
  }
}

function stopPlayback(toStart) {
  try { player.pause(); } catch (e) {}
  playing = false;
  cancelAnimationFrame(rafId);
  if (toStart !== false) { try { player.currentTime = trimIn(); } catch (e) {} }
  setPlayIcon(false);
  $('tNow').textContent = fmtTime(playTime());
  drawStage(); drawSheet(); drawOverview();
}

/* Jumping to the head and the tail, and looping.

   The tail lands one frame short of the duration rather than on it: seeking to
   the very end leaves most browsers showing black, and the last drawn frame is
   the one you actually want to look at. Looping is the element's own `loop`,
   so the wrap happens in the media stack and never drifts against the sheet. */
let looping = false;

function transportEnabled(on) {
  ['playBtn', 'stopBtn', 'headBtn', 'tailBtn', 'loopBtn']
    .forEach(id => { const b = $(id); if (b) b.disabled = !on; });
}

function jumpTo(where) {
  if (!state.buffer) return;
  const d = state.buffer.duration;
  seekTo(where === 'end' ? Math.max(0, d - 1 / Math.max(1, state.fps)) : 0);
  drawStage(); drawSheet(); drawOverview();
}

function setLooping(on) {
  looping = !!on;
  // Native looping wraps the whole FILE, which is wrong for a trimmed clip —
  // there the wrap is done by hand in tick().
  player.loop = looping && !isTrimmed();
  const b = $('loopBtn');
  if (b) b.setAttribute('aria-pressed', looping ? 'true' : 'false');
}

/* ---- playing the whole conversation -------------------------------------

   Straight through, line by line, through the transport that already exists:
   open the clip, play it to its out point, open the next. No render pass and
   nothing held in memory, so it starts the moment you press it and what you
   watch is the preview itself — the same pixels the stage draws when you play
   one line, rather than a copy of them that could disagree.

   The gap between lines is one open. For a split take that is now a slice of
   an already-decoded source (see srcCache), which is the difference between
   "lines" and "lines, eventually". */
const playAll = { on: false, at: -1, token: 0, wasLooping: false };
let playAllDone = null;         // resolves the line that is playing

/** The line that was playing has finished. */
function playAllLineEnded() {
  const f = playAllDone;
  playAllDone = null;
  if (f) f();
}

function playAllStop(quiet) {
  if (!playAll.on) return false;
  playAll.on = false;
  playAll.at = -1;
  playAll.token++;
  playAllLineEnded();
  setLooping(playAll.wasLooping);
  try { player.pause(); } catch (e) {}
  syncPlayAllUI();
  renderQueue();
  if (!quiet) toast('Stopped.', 1600);
  return true;
}

function syncPlayAllUI() {
  const b = $('playAllBtn');
  if (!b) return;
  b.hidden = queue.clips.length < 2;
  b.textContent = playAll.on ? 'Stop' : 'Play all';
  b.setAttribute('aria-pressed', playAll.on ? 'true' : 'false');
  b.title = playAll.on
    ? 'Stop playing the conversation'
    : 'Play every line in order, from the top';
  b.classList.toggle('on', playAll.on);
}

/** Wait for the line that is on to reach its out point. */
function playAllLine(mine) {
  return new Promise(resolve => {
    playAllDone = resolve;
    player.play().then(() => {}, e => {
      // Autoplay refused, or the element lost its source: say so once and
      // stop, rather than spinning silently through the queue.
      console.warn('play all could not start a line', e);
      if (playAll.token === mine) {
        toast('The browser would not start playback: ' + (e && (e.name || e.message) || e), 4200);
        playAllStop(true);
      }
      playAllLineEnded();
    });
  });
}

async function playAllRun() {
  if (playAllStop()) return;              // pressing it again is "stop"
  if (queue.clips.length < 2) return;
  playAll.on = true;
  playAll.wasLooping = looping;
  setLooping(false);                      // a looping line would never end
  const mine = ++playAll.token;
  syncPlayAllUI();
  const ids = queue.clips.map(c => c.id);
  for (let i = 0; i < ids.length; i++) {
    if (!playAll.on || mine !== playAll.token) break;
    const c = clipById(ids[i]);
    if (!c) continue;
    playAll.at = i;
    await openClip(c.id, { force: true });
    await awaitPlate();
    if (!playAll.on || mine !== playAll.token) break;
    if (!state.buffer) continue;          // a line that would not read is skipped
    syncPlayAllUI();
    seekTo(0);
    await playAllLine(mine);
  }
  if (mine === playAll.token) {
    playAll.on = false;
    playAll.at = -1;
    setLooping(playAll.wasLooping);
    syncPlayAllUI();
    renderQueue();
  }
}

function seekTo(t) {
  if (!state.buffer) return;
  const c = activeClip();
  const tc = clamp(t, 0, Math.max(0, state.buffer.duration - 0.01));
  const at = (!c || !(c.drops || []).length) ? trimIn() + tc : clipToSrc(c, tc);
  try { player.currentTime = at; } catch (e) {}
  $('tNow').textContent = fmtTime(playTime());
  drawTrim();
  if (!playing) updateOverlayReadout();
}

['loadeddata', 'canplay', 'seeked', 'loadedmetadata'].forEach(ev =>
  player.addEventListener(ev, () => { if (state.video && !playing) drawStage(); }));
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const onFrame = () => {
    if (state.video && !playing) drawStage();
    try { player.requestVideoFrameCallback(onFrame); } catch (e) {}
  };
  try { player.requestVideoFrameCallback(onFrame); } catch (e) {}
}

player.addEventListener('play', () => { playing = true; setPlayIcon(true); tick(); });
player.addEventListener('pause', () => { playing = false; setPlayIcon(false); cancelAnimationFrame(rafId); drawSheet(); drawStage(); });
player.addEventListener('ended', () => {
  playing = false; setPlayIcon(false); cancelAnimationFrame(rafId);
  drawStage(); drawSheet(); drawOverview();
  playAllLineEnded();            // an untrimmed line ends at the file's end
});
player.addEventListener('error', () => {
  if (!player.getAttribute('src')) return;
  toast('This browser cannot play that audio format, though the analysis still ran.', 4600);
  $('playBtn').disabled = true;
});

/* --------------------------------------------------------- 8. ZIP + exports */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal store-only ZIP. PNGs are already deflated; compressing again buys
    nothing and costs a dependency. */
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = files.map(f => ({ name: enc.encode(f.name), data: f.data, crc: crc32(f.data) }));
  let size = 22;
  for (const p of parts) size += 30 + p.name.length + p.data.length + 46 + p.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let o = 0;
  const offsets = [];
  for (const p of parts) {
    offsets.push(o);
    dv.setUint32(o, 0x04034B50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 0x0800, true);       // UTF-8 names
    dv.setUint16(o + 8, 0, true);            // stored
    dv.setUint16(o + 10, dosTime, true);
    dv.setUint16(o + 12, dosDate, true);
    dv.setUint32(o + 14, p.crc, true);
    dv.setUint32(o + 18, p.data.length, true);
    dv.setUint32(o + 22, p.data.length, true);
    dv.setUint16(o + 26, p.name.length, true);
    dv.setUint16(o + 28, 0, true);
    o += 30;
    out.set(p.name, o); o += p.name.length;
    out.set(p.data, o); o += p.data.length;
  }
  const cdStart = o;
  parts.forEach((p, i) => {
    dv.setUint32(o, 0x02014B50, true);
    dv.setUint16(o + 4, 20, true);
    dv.setUint16(o + 6, 20, true);
    dv.setUint16(o + 8, 0x0800, true);
    dv.setUint16(o + 10, 0, true);
    dv.setUint16(o + 12, dosTime, true);
    dv.setUint16(o + 14, dosDate, true);
    dv.setUint32(o + 16, p.crc, true);
    dv.setUint32(o + 20, p.data.length, true);
    dv.setUint32(o + 24, p.data.length, true);
    dv.setUint16(o + 28, p.name.length, true);
    dv.setUint16(o + 30, 0, true);
    dv.setUint16(o + 32, 0, true);
    dv.setUint16(o + 34, 0, true);
    dv.setUint16(o + 36, 0, true);
    dv.setUint32(o + 38, 0, true);
    dv.setUint32(o + 42, offsets[i], true);
    o += 46;
    out.set(p.name, o); o += p.name.length;
  });
  dv.setUint32(o, 0x06054B50, true);
  dv.setUint16(o + 8, parts.length, true);
  dv.setUint16(o + 10, parts.length, true);
  dv.setUint32(o + 12, o - cdStart, true);
  dv.setUint32(o + 16, cdStart, true);
  return new Blob([out], { type: 'application/zip' });
}

/** A canvas as PNG bytes. The browser's own encoder, so the alpha comes out
    as eight real bits rather than the on-or-off a palette would give. */
async function canvasPng(c) {
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function pngBytes(size, v) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paintMouth(c.getContext('2d'), size, size, v, state.style);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Every shape rendered once. A 1400-frame sequence reuses these nine buffers.

    All nine, always — not just the ones this take happened to use. A take with
    no F in it still needs an F on disk the moment someone opens the chart in
    Final Cut or After Effects and wants to fix a frame by hand, and there is
    no way to draw one after the fact. Three spare PNGs cost almost nothing;
    a missing shape costs a re-export. */
async function renderChart(size, onStep) {
  const out = {};
  for (let i = 0; i < VIS.length; i++) {
    out[VIS[i]] = await pngBytes(size, VIS[i]);
    if (onStep) onStep((i + 1) / VIS.length);
  }
  return out;
}

/** Which shapes the analysis actually chose. Reporting only — never the set
    that gets exported. */
function usedVisemes() {
  if (!state.frames.length) return VIS.slice();
  const s = new Set(state.frames.map(f => f.v));
  return VIS.filter(v => s.has(v));
}

function runs() {
  const out = [];
  for (let i = 0; i < state.frames.length; i++) {
    const v = state.frames[i].v;
    if (out.length && out[out.length - 1].viseme === v) out[out.length - 1].endFrame = i;
    else out.push({ startFrame: i, endFrame: i, viseme: v });
  }
  return out.map(r => ({
    ...r,
    startTime: +(r.startFrame / state.fps).toFixed(4),
    endTime: +((r.endFrame + 1) / state.fps).toFixed(4),
    frames: r.endFrame - r.startFrame + 1
  }));
}

function timingJSON(size) {
  return JSON.stringify({
    generator: 'Lip Sync Generator',
    source: state.name || 'untitled',
    engine: ENGINES[engine].label,
    fps: state.fps,
    frameCount: state.frames.length,
    duration: +(state.buffer ? state.buffer.duration.toFixed(4) : 0),
    imageSize: size,
    style: custom.on ? 'custom' : state.style,
    visemeNames: VNAME,
    shapes: VIS.slice(),            // every shape in the export
    shapesUsed: usedVisemes(),      // the ones this take actually called for
    // x, y and size are fractions of the frame; rot is degrees, clockwise
    overlay: { base: pose() },
    runs: runs(),
    frames: state.frames.map((f, i) => ({ frame: i, time: +(i / state.fps).toFixed(4), viseme: f.v }))
  }, null, 2);
}

function timingCSV() {
  const rows = ['frame,time,viseme,description'];
  state.frames.forEach((f, i) =>
    rows.push([i, (i / state.fps).toFixed(4), f.v, '"' + VNAME[f.v] + '"'].join(',')));
  return rows.join('\n');
}

function readme(size) {
  const u = usedVisemes();
  return [
    'LIP SYNC GENERATOR EXPORT',
    '=========================',
    '',
    'Written by  : Lip Sync Generator v' + APP_VERSION,
    'Source      : ' + (state.name || 'untitled'),
    'Frame rate  : ' + state.fps + ' fps',
    'Frames      : ' + state.frames.length,
    'Image size  : ' + size + ' x ' + size + ' px, transparent PNG',
    'Shapes used : ' + u.join(' ') + '   (of ' + VIS.join(' ') + ')',
    '',
    'THE WHOLE SET IS HERE',
    (u.length === VIS.length
      ? '  All ' + VIS.length + ' shapes are in mouths/, and this take used every one.'
      : '  All ' + VIS.length + ' shapes are in mouths/, not only the ' + u.length + ' this take used.\n' +
        '  The spares (' + VIS.filter(v => !u.includes(v)).join(' ') + ') are there so you can fix a frame by\n' +
        '  hand later without coming back for another export.'),
    '',
    'SHAPE KEY (Preston Blair / Rhubarb vocabulary)',
    ...VIS.map(v => '  ' + v + '  ' + VNAME[v] + (u.includes(v) ? '' : '   (unused in this take)')),
    '',
    'USING THE TIMING',
    '  timing.csv   one row per frame: frame, time in seconds, shape',
    '  timing.json  the same data plus "runs" — contiguous holds, which is',
    '               usually what you want when keying by hand',
    '',
    'CHROMA-KEY MP4 the key colour is flat, but video chroma is stored at half',
    '               resolution, so the matte edge is softer than the PNG alpha.',
    '               Use the frame sequence when you need a clean matte.',
    '',
    'AFTER EFFECTS  import the mouth PNGs, put them in one comp as a layer',
    '               set, and use timing.csv to place holds on the time',
    '               remap or a source-text expression.',
    'BLENDER        drive an image-sequence or shape-key index from the',
    '               frame column with a driver or a short Python import.',
    'SPINE / UNITY  the sprite-sheet export ships an atlas.json alongside.',
    '',
    'Engine      : ' + ENGINES[engine].label,
    '',
    'Generated by Lip Sync Generator. Analysis ran entirely in the browser.',
    'The Rhubarb engine embeds Rhubarb Lip Sync (Daniel Wolf, MIT) and',
    'PocketSphinx (Carnegie Mellon University, BSD).'
  ].join('\n');
}

/** No sheet wider or taller than this. Plenty of engines and browsers stop
    loading a texture somewhere past 4096, and a sheet nobody can open is worse
    than a sheet with smaller cells in it. */
const SPRITE_SHEET_MAX = 4096;

/** The sprite sheet with the puppet in it: the cells stop being nine mouths and
    become whole pictures.

    How many there are depends on what is behind them. A still puppet that is
    not being moved by keyframes makes the same picture every time a shape comes
    round, so nine cells still say everything and the atlas points every run at
    one of them. A video puppet, or a keyframed move, is different on every
    frame, so the sheet becomes a flipbook — one cell per frame — and the cells
    shrink to whatever fits. The atlas gains `sequence`, which is the cell to
    show on each frame in order; an engine that only wants the nine can keep
    reading `frames` and ignore it. */
async function makeSpritePlateSheet() {
  const flip = everyFrameDiffers();
  const fz = plateCellSize(1024);
  const cells = [];                       // {key, t}
  const seqIdx = [];                      // one entry per frame, into cells
  if (flip) {
    for (let i = 0; i < state.frames.length; i++) { seqIdx.push(cells.length); cells.push({ key: i, t: i / state.fps }); }
  } else {
    const at = new Map();
    for (let i = 0; i < state.frames.length; i++) {
      const v = state.frames[i].v;
      if (!at.has(v)) { at.set(v, cells.length); cells.push({ key: v, t: i / state.fps }); }
      seqIdx.push(at.get(v));
    }
  }
  // Squarish, then shrunk until the sheet fits the texture limit.
  const cols = Math.max(1, Math.min(cells.length, Math.ceil(Math.sqrt(cells.length * fz.h / fz.w))));
  const rows = Math.ceil(cells.length / cols);
  const fit = Math.min(1, SPRITE_SHEET_MAX / (cols * fz.w), SPRITE_SHEET_MAX / (rows * fz.h));
  const cw = Math.max(2, Math.floor(fz.w * fit)), ch = Math.max(2, Math.floor(fz.h * fit));

  const c = document.createElement('canvas');
  c.width = cols * cw; c.height = rows * ch;
  const ctx = c.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  const tctx = tmp.getContext('2d');

  const atlas = { image: 'mouth-sprites.png', frameWidth: cw, frameHeight: ch,
                  columns: cols, rows, withPuppet: true, frames: {}, cells: [] };
  for (let i = 0; i < cells.length; i++) {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    await composePlateFrame(tctx, cw, ch, cells[i].t, null, fxOpt('spriteFx'));
    ctx.drawImage(tmp, x, y);
    const box = { x, y, w: cw, h: ch };
    atlas.cells.push(box);
    if (!flip) atlas.frames[cells[i].key] = { ...box, name: VNAME[cells[i].key] };
    if ((i & 3) === 3) await new Promise(r => setTimeout(r, 0));
  }
  atlas.sequence = seqIdx;
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), atlas };
}

async function makeSpriteSheet(size) {
  if (plateOn('spritePlate')) return makeSpritePlateSheet();
  const used = VIS;
  const cols = Math.min(used.length, 5);
  const rows = Math.ceil(used.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * size; c.height = rows * size;
  const ctx = c.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = size;
  const tctx = tmp.getContext('2d');
  const atlas = { image: 'mouth-sprites.png', frameWidth: size, frameHeight: size, columns: cols, rows, frames: {} };
  used.forEach((v, i) => {
    const x = (i % cols) * size, y = Math.floor(i / cols) * size;
    paintMouth(tctx, size, size, v, state.style);
    ctx.drawImage(tmp, x, y);
    atlas.frames[v] = { x, y, w: size, h: size, name: VNAME[v] };
  });
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), atlas };
}

/** One PNG holding every shape in a row, for the hosted build where a zip of
    loose files is not an option. */
async function makeContactSheet(size) {
  return (await makeSpriteSheet(size)).bytes;
}

/* --- the voice track, alongside the pictures --------------------------------

   Off by default. When it is on, an export that is already a zip gains one
   more file, and the GIF — normally a bare .gif — becomes a zip so there is
   somewhere to put it. Nothing is transcoded that does not have to be: an
   audio file the user supplied ships exactly as they supplied it, and only a
   soundtrack pulled out of a video is written fresh, as a WAV, because that is
   the one format every editor takes without argument.
--------------------------------------------------------------------------- */

function wavBytes(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels), sr = buffer.sampleRate;
  const n = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const put = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  put(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      o += 2;
    }
  }
  return new Uint8Array(data.buffer);
}

/** Each export that can carry a voice track has its own tick box, so the
    choice is made where the file is asked for rather than in a global setting
    three cards away. */
const wantsAudio = id => !!(($(id) || {}).checked);

/** The one file to ship beside an export, or null. `box` is the id of the
    tick box on the card asking for it. */
async function audioSidecar(box) {
  if (!wantsAudio(box)) return null;
  const stem = (state.name || 'voice').replace(/\.[^.]+$/, '');
  // Beside the pictures, not tucked under an audio/ folder — you are going to
  // drag it onto a timeline next to them, so that is where it should be.
  // Audio in, audio out: byte for byte, no quality lost to a round trip — but
  // only when the clip really is the whole file. Trimmed or with a bit dropped,
  // the original bytes are no longer what the timing describes, and shipping
  // them would put a sidecar on the timeline that runs longer than the mouths
  // and starts in the wrong place.
  if (state.file && !state.video && !isTrimmed()) {
    const ext = (state.file.name.match(/\.[^.]+$/) || ['.wav'])[0];
    return { name: stem + ext, data: new Uint8Array(await state.file.arrayBuffer()) };
  }
  if (!state.buffer) return null;
  return { name: stem + '.wav', data: wavBytes(state.buffer) };
}

/* --- delivery ------------------------------------------------------------- */

/** Where an export's files go. Given a `sink` — batch mode — they are folded
    into that clip's single zip under a folder of their own; on their own they
    become the zip the browser downloads. One place decides, so batch and
    single-file exports can never drift apart in what they contain. */
async function emit(sink, zipName, folder, files) {
  // Array.isArray, not truthiness: wired straight to a button these functions
  // are handed a click event, and a truthy check would silently swallow the
  // download. It cost one debugging round to learn that.
  if (Array.isArray(sink)) {
    // A folder per format only when there is more than one format to keep
    // apart. Ask the batch for a GIF alone and the zip is a GIF and a WAV,
    // side by side, exactly as if you had exported it by hand.
    const at = sink.prefix ? folder + '/' : '';
    files.forEach(f => sink.push({ name: at + f.name, data: f.data }));
    return;
  }
  await deliver(zipName, makeZip(files));
}

async function deliver(filename, data, mime) {
  if (download.mode === 'artifact') {
    await download.api.save({ filename, data: data instanceof Blob ? data : data });
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function setBusy(on, pct) {
  // The progress bar lives in the Export panel; if a long render is running,
  // that is the pane worth being on.
  if (on && activeTab !== 'export') showTab('export');
  $('progress').classList.toggle('on', !!on);
  $('progressBar').style.width = ((pct || 0) * 100).toFixed(0) + '%';
  working(!!on, on ? 'Exporting… ' + Math.round((pct || 0) * 100) + '%' : '');
  if (on) ['expChart', 'expFcp', 'expSeq', 'expSprite', 'expMp4', 'expOverlay', 'expGif', 'expApng']
    .forEach(id => { $(id).disabled = true; });
  else setExportsEnabled(state.frames.length > 0);
}

async function exportChart(sink) {
  const size = parseInt($('outSize').value, 10);
  const base = exportName('chart');
  setBusy(true, 0);
  try {
    if (download.mode === 'artifact') {
      const sheet = await makeContactSheet(size);
      setBusy(true, .5);
      await deliver(base + '.png', sheet);
      await deliver(base + '-timing.json', timingJSON(size));
      await deliver(base + '-timing.csv', timingCSV());
      toast('Saved the chart sheet and both timing files.');
    } else {
      const chart = await renderChart(size, p => setBusy(true, p * 0.8));
      const files = Object.keys(chart).map(v => ({ name: 'mouths/mouth-' + v + '.png', data: chart[v] }));
      const enc = new TextEncoder();
      files.push({ name: 'timing.json', data: enc.encode(timingJSON(size)) });
      files.push({ name: 'timing.csv', data: enc.encode(timingCSV()) });
      const voice = await audioSidecar('audChart');
      if (voice) files.push(voice);
      files.push({ name: 'README.txt', data: enc.encode(readme(size)) });
      setBusy(true, .95);
      await emit(sink, base + '.zip', 'chart', files);
      toast('Exported ' + Object.keys(chart).length + ' shapes with frame timing.');
    }
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Export failed: ' + (e.message || e), 4000);
  }
  setBusy(false);
}

/* --------------------------------------------------------------- FCPXML

   Final Cut Pro reads FCPXML. It does NOT read the "xmeml" that Final Cut Pro
   7 used and that Premiere still accepts — the two look alike in a text editor
   and are not interchangeable, which is the usual reason a hand-rolled "Final
   Cut XML" imports everywhere except Final Cut. What follows is real FCPXML,
   and the test suite validates it against Apple's own DTD rather than trusting
   that it looks right.

   The mouth is baked into full-frame transparent PNGs the size of the
   timeline, not exported as a small tile with a transform in the XML. Nine
   images, each already carrying the placement, size and angle set on the
   overlay, so Final Cut needs no transform at all: every clip sits at 100% and
   what you lined up here is what lands there. */

function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a || 1; }

/** FCPXML times are rationals in seconds. They have to divide by the sequence
    frame duration exactly, or Final Cut quietly rounds them somewhere else —
    which is how lip sync ends up a frame out. */
function fcpTime(frames, fps) {
  if (!frames) return '0s';
  const g = gcd(frames, fps);
  const n = frames / g, d = fps / g;
  return d === 1 ? n + 's' : n + '/' + d + 's';
}

/** The frame the FCPXML is cut for. Matching the video is the useful default,
    because then the baked-in placement lands pixel for pixel. */
/* During a batch the timeline size is pinned. "Match the video" otherwise
   re-picks itself as each clip opens, so a queue of mixed sources would come
   out as a set of projects at different sizes — and the combined timeline,
   which can only be one size, would have to drop most of them. */
let fcpSizeLock = null;

function fcpFrameSize() {
  if (fcpSizeLock) return fcpSizeLock;
  const sel = ($('fcpSize') || {}).value || '1920x1080';
  if (sel === 'video' && frameHasContent()) return frameSize();
  const m = /^(\d+)x(\d+)$/.exec(sel === 'video' ? '1920x1080' : sel);
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

/** Where the mouth sits inside an exported frame. With a picture behind it —
    the clip's own footage or a puppet — that is exactly the overlay you placed,
    angle and all. With nothing there is nothing to line up against, so it goes
    in the middle at a workable size. */
function fcpPlacement(W, H, p) {
  if (hasPlate()) {
    p = p || pose();
    return { cx: p.x * W, cy: p.y * H, s: p.size * W, rot: p.rot * Math.PI / 180 };
  }
  return { cx: W / 2, cy: H / 2, s: W * 0.45, rot: 0 };
}

/* Final Cut gets one still per shape, placed where you put the mouth.

   It deliberately does NOT carry the keyframed motion or the blur patch. Both
   of those are properties of a particular video frame — the blur has to have
   something underneath it to blur, and baking the motion meant a separate
   picture per placement, hundreds of stills for a slow pan. In Final Cut the
   right place to animate a position is Final Cut, on a clip you can see. So
   the mouth ships at its resting placement and the movement is yours to do
   there; the overlay video export is the one that bakes motion in. */

function fcpSegments(W, H) {
  const segs = [];
  for (let i = 0; i < state.frames.length; i++) {
    const v = state.frames[i].v;
    const last = segs[segs.length - 1];
    if (last && last.id === v) { last.endFrame = i; continue; }
    segs.push({ id: v, viseme: v, pose: pose(), startFrame: i, endFrame: i });
  }
  return segs.map(g => ({ ...g, frames: g.endFrame - g.startFrame + 1 }));
}

/** The distinct pictures the timeline needs, in the order they first appear. */
function fcpStates(W, H) {
  const seen = new Map();
  fcpSegments(W, H).forEach(g => {
    if (seen.has(g.id)) return;
    seen.set(g.id, { id: g.id, viseme: g.viseme, pose: g.pose,
                     file: 'mouths/mouth-' + g.viseme + '.png' });
  });
  return [...seen.values()];
}

async function fcpFramePng(W, H, v, p) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = fcpPlacement(W, H, p);
  ctx.save();
  ctx.translate(g.cx, g.cy);
  ctx.rotate(g.rot);
  const px = Math.min(2048, Math.max(64, Math.round(g.s * 1.5)));
  ctx.drawImage(mouthImage(px, v, state.style), -g.s / 2, -g.s / 2, g.s, g.s);
  ctx.restore();
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xmlEsc(v) { return String(v).replace(/[&<>"']/g, c => XML_ESC[c]); }

/** Only name a format when it really is one of Final Cut's presets; a made-up
    name on an odd size is worse than none, because Final Cut trusts the name
    over the numbers. */
function fcpFormatName(w, h, fps) {
  const std = { 720: '720p', 1080: '1080p', 2160: '2160p' };
  if (w === Math.round(h * 16 / 9) && std[h] && [24, 25, 30, 50, 60].includes(fps)) {
    return 'FFVideoFormat' + std[h] + fps;
  }
  return null;
}

/** Absolute file URL for a media file, or a path relative to the .fcpxml when
    no folder is given. Relative keeps the zip self-contained; absolute is the
    certain option for anyone who knows where the folder will live. */
function fcpMediaSrc(folder, rel) {
  if (!folder) return './' + rel;
  const parts = (folder.replace(/^\/+|\/+$/g, '') + '/' + rel).split('/').filter(Boolean);
  return 'file:///' + parts.map(encodeURIComponent).join('/');
}

/** Is the Final Cut export to arrive as a compound clip? A run of mouths is
    dozens of one-frame items on the spine, and the first thing anyone does in
    Final Cut is select the lot and make a compound so they can be moved as one.
    Doing it here saves that step. The box is on the card so it can be turned
    off by anyone who wants the bare clips. */
function fcpWrapCompound() {
  const b = $('fcpCompound');
  return b ? !!b.checked : true;
}

/** A compound clip: a <media> resource holding a sequence of its own, dropped
    on the timeline as a single <ref-clip>. The clips inside are exactly the
    ones that would otherwise have gone straight onto the spine, so unwrapping
    in Final Cut (Clip > Break Apart Clip Items) gets you back to the flat
    version — nothing is lost by ticking the box. */
function fcpCompoundMedia(id, name, videoLines, frames, fps) {
  const L = [];
  L.push('    <media id="' + id + '" name="' + xmlEsc(name) + '">');
  L.push('      <sequence format="r1" duration="' + fcpTime(frames, fps) +
         '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
  L.push('        <spine>');
  videoLines.forEach(v => L.push('          ' + v));
  L.push('        </spine>');
  L.push('      </sequence>');
  L.push('    </media>');
  return L;
}

/* --- the puppet as a layer, not as baked-in pixels ---------------------------

   Every other export that carries the puppet composites it: the mouth is drawn
   onto the picture and what comes out is finished. Final Cut is the one place
   where that would be the wrong answer. An editor opening a project wants the
   puppet on the spine and the mouths above it, so the two can be slid apart,
   the placement nudged, and a wrong shape swapped — which is the whole reason
   to hand somebody a project rather than a movie.

   So the puppet ships as its own file inside the zip and goes on the spine,
   with the mouths hung off it as a connected clip in lane 1. `srcEnable="video"`
   is what mutes it, and it mutes it at the source rather than by pulling a
   fader down, so there is nothing to undo by accident.
--------------------------------------------------------------------------- */

/** What the export knows about the puppet it is shipping, or null. `dur` is in
    frames of the sequence, already clamped to the take. */
function fcpPuppetInfo() {
  const f = plateFile();
  const pz = frameSize();
  if (!f || !pz) return null;
  const kind = puppet.kind || (state.video ? 'video' : null);
  if (!kind) return null;
  const total = state.frames.length;
  const dur = kind === 'image' || !(puppet.duration > 0)
    ? total
    : Math.max(1, Math.min(total, Math.round(puppet.duration * state.fps)));
  return { file: f, kind, w: pz.w, h: pz.h, dur, total,
           short: dur < total,
           rel: 'puppet/' + safeName(f.name || (kind === 'image' ? 'puppet.png' : 'puppet.mov')) };
}

/** The puppet's bytes for the project.

    Normally the file itself, untouched: a puppet in Final Cut should be the
    picture you chose, as a layer you can still move there.

    Once the puppet can be placed on the stage, that stops being enough — the
    project would open with the picture full-frame and the mouths positioned
    for a picture that had been moved. FCPXML can express a transform, but its
    position units are the sequence's own and getting them wrong is worse than
    not trying, so for a STILL the placement is rendered into a full-frame PNG
    instead. The result is exact, it is still one layer you can move in Final
    Cut, and it needs no transform at all — the same trick the mouth stills
    already use.

    A video puppet keeps its file; there is no rendering a video in a page
    without re-encoding it. The export card says so, and the mirror stays a
    transform as it always was. */
async function fcpPuppetBytes(pup) {
  const posed = puppetMoved() || mirror.plate;
  if (!posed || pup.kind !== 'image' || !puppet.img) {
    return { data: new Uint8Array(await pup.file.arrayBuffer()), baked: false };
  }
  const c = document.createElement('canvas');
  c.width = Math.max(1, pup.w); c.height = Math.max(1, pup.h);
  const x = c.getContext('2d');
  applyPuppetTransform(x, c.width, c.height);
  x.drawImage(puppet.img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), baked: true };
}

/* --- the voice track, on the timeline rather than beside it -------------------

   Ticking "Include the voice track" used to put the audio file in the zip and
   stop there: the project imported with mouths and silence, and the one thing
   left to do by hand was the thing the box appeared to promise. Now the file is
   also an asset in the document and a connected clip at lane -1, so the project
   opens with picture and sound already together at 00:00.

   Lane -1 rather than the spine: audio connected BELOW the storyline is how
   Final Cut expresses "this sound belongs with that picture", and it means
   moving the mouths moves the voice with them.

   Times are in the audio's own sample rate, not the sequence's frame rate.
   Rounding the voice track to whole frames would either cut up to a frame off
   the end or claim more media than the file has, and Final Cut is content with
   sub-frame audio — that is how every audio-led edit in FCPXML is written. */
function fcpAudioInfo(voice) {
  if (!voice || !state.buffer) return null;
  const rate = Math.round(state.buffer.sampleRate) || 48000;
  const samples = Math.max(1, Math.round(state.buffer.duration * rate));
  return {
    rel: voice.name,
    rate,
    samples,
    channels: Math.min(2, state.buffer.numberOfChannels) || 1,
    dur: fcpSeconds(samples, rate)
  };
}

/** The one line that puts a voice track under a clip. Offset is 0 because a
    connected clip's offset is measured from its parent's start, and the parent
    is whatever that clip's picture is. */
function voiceLine(au) {
  return '<audio ref="' + au.id + '" lane="-1" offset="0s" name="voice" start="0s" duration="' +
         au.dur + '" role="dialogue"/>';
}

/** A %time% from a sample count, reduced the way fcpTime reduces frames. */
function fcpSeconds(n, rate) {
  if (!n) return '0s';
  const g = gcd(n, rate);
  const a = n / g, b = rate / g;
  return b === 1 ? a + 's' : a + '/' + b + 's';
}

function fcpxmlDoc(opts) {
  const { w, h, folder } = opts;
  const fps = state.fps;
  const used = usedVisemes();
  const segs = fcpSegments(w, h);
  const states = fcpStates(w, h);
  const total = state.frames.length;
  const proj = (state.name || 'Lip Sync Generator').replace(/\.[^.]+$/, '');

  const ids = {};
  states.forEach((st, i) => { ids[st.id] = 'r' + (i + 3); });

  const seqName = fcpFormatName(w, h, fps);
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!DOCTYPE fcpxml>');
  L.push('<fcpxml version="1.10">');
  L.push('  <resources>');
  L.push('    <format id="r1"' + (seqName ? ' name="' + seqName + '"' : '') +
         ' frameDuration="' + fcpTime(1, fps) + '" width="' + w + '" height="' + h +
         '" colorSpace="1-1-1 (Rec. 709)"/>');
  // Stills have no frame rate of their own, which is what RateUndefined says.
  L.push('    <format id="r2" name="FFVideoFormatRateUndefined" width="' + w +
         '" height="' + h + '" colorSpace="1-13-1"/>');
  states.forEach(st => {
    L.push('    <asset id="' + ids[st.id] + '" name="' + xmlEsc('mouth-' + st.viseme) +
           '" start="0s" duration="0s" hasVideo="1" format="r2" videoSources="1">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc(folder, st.file)) + '"/>');
    L.push('    </asset>');
  });

  const mouths = segs.map(g =>
    '<video ref="' + ids[g.id] + '" offset="' + fcpTime(g.startFrame, fps) +
    '" name="' + xmlEsc(g.viseme + ' · ' + VNAME[g.viseme]) +
    '" start="0s" duration="' + fcpTime(g.frames, fps) + '"/>');
  const wrap = fcpWrapCompound();
  const compName = proj + ' — mouths';
  const compId = 'r' + (states.length + 3);
  if (wrap) fcpCompoundMedia(compId, compName, mouths, total, fps).forEach(l => L.push(l));

  // The puppet, if it is coming. A still needs no format of its own — it takes
  // the RateUndefined one the mouths use. A movie gets one, at the sequence's
  // frame duration: the file's own rate is not something a browser will tell
  // us, and Final Cut conforms a mismatched clip on import anyway.
  const pup = opts.puppet;
  const pupId = 'r' + (states.length + 4), pupFmt = 'r' + (states.length + 5);
  if (pup) {
    if (pup.kind !== 'image') {
      L.push('    <format id="' + pupFmt + '" frameDuration="' + fcpTime(1, fps) +
             '" width="' + pup.w + '" height="' + pup.h + '" colorSpace="1-1-1 (Rec. 709)"/>');
    }
    L.push('    <asset id="' + pupId + '" name="' + xmlEsc('puppet') +
           '" start="0s" duration="' +
           (pup.kind === 'image' ? '0s' : fcpTime(pup.dur, fps)) +
           '" hasVideo="1" hasAudio="0" format="' +
           (pup.kind === 'image' ? 'r2' : pupFmt) + '" videoSources="1" audioSources="0">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc(folder, pup.rel)) + '"/>');
    L.push('    </asset>');
  }

  const aud = opts.audio;
  const audId = 'r' + (states.length + 6);
  if (aud) {
    L.push('    <asset id="' + audId + '" name="' + xmlEsc('voice') +
           '" start="0s" duration="' + aud.dur + '" hasVideo="0" hasAudio="1"' +
           ' audioSources="1" audioChannels="' + aud.channels +
           '" audioRate="' + aud.rate + '">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc(folder, aud.rel)) + '"/>');
    L.push('    </asset>');
  }

  L.push('  </resources>');
  L.push('  <library>');
  L.push('    <event name="' + xmlEsc(proj) + '">');
  L.push('      <project name="' + xmlEsc(proj + ' — lip sync') + '">');
  L.push('        <sequence format="r1" duration="' + fcpTime(total, fps) +
         '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
  L.push('          <spine>');
  // Lane 1 when the puppet is under them, no lane when they are the spine
  // themselves. A connected clip is written as a child of what it is connected
  // to, which is why the two cases are shaped differently rather than differing
  // by one attribute.
  const lane = pup ? ' lane="1"' : '';
  const above = wrap
    ? ['<ref-clip ref="' + compId + '"' + lane + ' offset="0s" name="' +
       xmlEsc(compName) + '" start="0s" duration="' + fcpTime(total, fps) + '"/>']
    : mouths.map(v => v.replace('<video ', '<video' + lane + ' '));
  // The voice, connected below whatever is first on the spine. Written once
  // here and used by both branches, because the only thing that changes is what
  // it hangs off.
  const voiceClip = aud ? voiceLine({ ...aud, id: audId }) : null;
  if (pup) {
    const open = pup.kind === 'image'
      ? '<video ref="' + pupId + '" offset="0s" name="puppet" start="0s" duration="' +
        fcpTime(pup.dur, fps) + '">'
      : '<asset-clip ref="' + pupId + '" offset="0s" name="puppet" start="0s" duration="' +
        fcpTime(pup.dur, fps) + '" format="' + pupFmt + '" srcEnable="video">';
    L.push('            ' + open);
    // The puppet file ships untouched, so a mirrored puppet is mirrored HERE
    // instead — a scale of -1 across, which is a transform the editor can see
    // and undo rather than a flip baked into somebody's original picture.
    // It has to come before the connected clips: the DTD puts the intrinsic
    // parameters ahead of the anchored items.
    // Baked: the placement, mirror and all, is already in the PNG, so a
    // transform here would apply it twice.
    if (mirror.plate && !pup.baked) L.push('              <adjust-transform scale="-1 1"/>');
    if (voiceClip) L.push('              ' + voiceClip);
    above.forEach(v => L.push('              ' + v));
    L.push('            ' + (pup.kind === 'image' ? '</video>' : '</asset-clip>'));
    // A puppet shorter than the take leaves the spine short, and Final Cut
    // fills the rest with black rather than looping. The app itself plays a
    // short puppet out and back; a project cannot express that without writing
    // a reversed copy of the clip, so this one is left honest and the README
    // says what to do about it.
    if (pup.short) {
      L.push('            <gap offset="' + fcpTime(pup.dur, fps) + '" name="Gap" start="0s" duration="' +
             fcpTime(total - pup.dur, fps) + '"/>');
    }
  } else if (voiceClip) {
    // No puppet: the voice hangs off the first thing on the spine, which is the
    // compound clip when the box is ticked and the first mouth when it is not.
    // A connected clip may run past its parent — that is what lets a one-frame
    // mouth carry a whole voice track.
    const first = above[0].replace(/\/>$/, '>');
    L.push('            ' + first);
    L.push('              ' + voiceClip);
    L.push('            ' + (first.startsWith('<ref-clip') ? '</ref-clip>' : '</video>'));
    above.slice(1).forEach(v => L.push('            ' + v));
  } else {
    above.forEach(v => L.push('            ' + v));
  }
  L.push('          </spine>');
  L.push('        </sequence>');
  L.push('      </project>');
  L.push('    </event>');
  L.push('  </library>');
  L.push('</fcpxml>');
  return L.join('\n') + '\n';
}

/** The whole queue as one project: every clip's mouths laid end to end in the
    order they were loaded, each clip keeping its own art. Same document shape
    as the single-clip version — one format, one spine — so what was verified
    to import cleanly still holds; only the number of assets grows.

    entries: [{ name, dir, frames, segs, states }], dir being the folder its
    pictures sit in inside the zip. */
function fcpxmlMulti(entries, w, h) {
  const fps = state.fps;
  const total = entries.reduce((n, e) => n + e.frames, 0);
  const seqName = fcpFormatName(w, h, fps);
  const proj = 'Lip sync — ' + entries.length + ' clips';

  // One asset per shape per clip: two clips can be wearing different lips.
  const ids = new Map();
  let next = 3;
  entries.forEach(e => e.states.forEach(st => {
    const key = e.dir + '|' + st.id;
    if (!ids.has(key)) ids.set(key, 'r' + (next++));
  }));

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!DOCTYPE fcpxml>');
  L.push('<fcpxml version="1.10">');
  L.push('  <resources>');
  L.push('    <format id="r1"' + (seqName ? ' name="' + seqName + '"' : '') +
         ' frameDuration="' + fcpTime(1, fps) + '" width="' + w + '" height="' + h +
         '" colorSpace="1-1-1 (Rec. 709)"/>');
  L.push('    <format id="r2" name="FFVideoFormatRateUndefined" width="' + w +
         '" height="' + h + '" colorSpace="1-13-1"/>');
  entries.forEach(e => e.states.forEach(st => {
    const id = ids.get(e.dir + '|' + st.id);
    L.push('    <asset id="' + id + '" name="' + xmlEsc(e.name + ' ' + st.viseme) +
           '" start="0s" duration="0s" hasVideo="1" format="r2" videoSources="1">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc('', e.dir + '/' + st.file.replace(/^mouths\//, ''))) + '"/>');
    L.push('    </asset>');
  }));

  // Each clip's mouths, as they would sit on the spine — offsets relative to
  // that clip's own start, because inside a compound zero is the clip's start.
  const wrap = fcpWrapCompound();
  const mouths = entries.map(e => e.segs.map(g =>
    '<video ref="' + ids.get(e.dir + '|' + g.id) +
    '" offset="' + fcpTime(g.startFrame, fps) +
    '" name="' + xmlEsc(e.name + ' · ' + g.viseme) +
    '" start="0s" duration="' + fcpTime(g.frames, fps) + '"/>'));
  const compIds = entries.map(() => 'r' + (next++));
  // A puppet per clip, each with its own asset and — for a movie — its own
  // format. Laid out here rather than inline below so the ids are allocated in
  // one place; two clips can be wearing different puppets, or one and none.
  const pups = entries.map(e => {
    if (!e.puppet) return null;
    const pu = { ...e.puppet, id: 'r' + (next++) };
    if (pu.kind !== 'image') pu.fmt = 'r' + (next++);
    return pu;
  });
  // One voice asset per clip that has one, for the same reason as the puppets:
  // two clips are two files, and the ids have to be handed out in one place.
  const auds = entries.map(e => e.audio ? { ...e.audio, id: 'r' + (next++) } : null);
  pups.forEach((pu, i) => {
    if (!pu) return;
    if (pu.fmt) {
      L.push('    <format id="' + pu.fmt + '" frameDuration="' + fcpTime(1, fps) +
             '" width="' + pu.w + '" height="' + pu.h + '" colorSpace="1-1-1 (Rec. 709)"/>');
    }
    L.push('    <asset id="' + pu.id + '" name="' + xmlEsc(entries[i].name + ' puppet') +
           '" start="0s" duration="' + (pu.kind === 'image' ? '0s' : fcpTime(pu.dur, fps)) +
           '" hasVideo="1" hasAudio="0" format="' + (pu.fmt || 'r2') +
           '" videoSources="1" audioSources="0">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc('', pu.rel)) + '"/>');
    L.push('    </asset>');
  });
  auds.forEach((au, i) => {
    if (!au) return;
    L.push('    <asset id="' + au.id + '" name="' + xmlEsc(entries[i].name + ' voice') +
           '" start="0s" duration="' + au.dur + '" hasVideo="0" hasAudio="1"' +
           ' audioSources="1" audioChannels="' + au.channels +
           '" audioRate="' + au.rate + '">');
    L.push('      <media-rep kind="original-media" src="' +
           xmlEsc(fcpMediaSrc('', au.rel)) + '"/>');
    L.push('    </asset>');
  });
  // Named after the numbered folder, so the compounds sort into running order
  // in the Final Cut browser rather than alphabetically by whatever the files
  // happened to be called.
  const compName = e => e.dir || e.name;
  if (wrap) entries.forEach((e, i) => {
    fcpCompoundMedia(compIds[i], compName(e), mouths[i], e.frames, fps)
      .forEach(l => L.push(l));
  });

  L.push('  </resources>');
  L.push('  <library>');
  L.push('    <event name="' + xmlEsc(proj) + '">');
  L.push('      <project name="' + xmlEsc(proj) + '">');
  L.push('        <sequence format="r1" duration="' + fcpTime(total, fps) +
         '" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
  L.push('          <spine>');
  let base = 0;
  entries.forEach((e, i) => {
    const pu = pups[i];
    const au = auds[i];
    const lane = pu ? ' lane="1"' : '';
    // Inside a puppet clip, zero is that clip's start; on the bare spine it is
    // the start of the whole timeline. That is the only difference between the
    // two branches, and it is the one that is easy to get wrong.
    const off = f => fcpTime(pu ? f : base + f, fps);
    const above = wrap
      ? ['<ref-clip ref="' + compIds[i] + '"' + lane + ' offset="' + off(0) +
         '" name="' + xmlEsc(compName(e)) + '" start="0s" duration="' +
         fcpTime(e.frames, fps) + '"/>']
      : e.segs.map(g =>
          '<video ref="' + ids.get(e.dir + '|' + g.id) + '"' + lane +
          ' offset="' + off(g.startFrame) +
          '" name="' + xmlEsc(e.name + ' · ' + g.viseme) +
          '" start="0s" duration="' + fcpTime(g.frames, fps) + '"/>');
    if (pu) {
      const open = pu.kind === 'image'
        ? '<video ref="' + pu.id + '" offset="' + fcpTime(base, fps) + '" name="' +
          xmlEsc(entries[i].name + ' puppet') + '" start="0s" duration="' +
          fcpTime(pu.dur, fps) + '">'
        : '<asset-clip ref="' + pu.id + '" offset="' + fcpTime(base, fps) + '" name="' +
          xmlEsc(entries[i].name + ' puppet') + '" start="0s" duration="' +
          fcpTime(pu.dur, fps) + '" format="' + pu.fmt + '" srcEnable="video">';
      L.push('            ' + open);
      if (pu.flip) L.push('              <adjust-transform scale="-1 1"/>');
      if (au) L.push('              ' + voiceLine(au));
      above.forEach(v => L.push('              ' + v));
      L.push('            ' + (pu.kind === 'image' ? '</video>' : '</asset-clip>'));
      if (pu.dur < e.frames) {
        L.push('            <gap offset="' + fcpTime(base + pu.dur, fps) +
               '" name="Gap" start="0s" duration="' + fcpTime(e.frames - pu.dur, fps) + '"/>');
      }
    } else if (au) {
      const first = above[0].replace(/\/>$/, '>');
      L.push('            ' + first);
      L.push('              ' + voiceLine(au));
      L.push('            ' + (first.startsWith('<ref-clip') ? '</ref-clip>' : '</video>'));
      above.slice(1).forEach(v => L.push('            ' + v));
    } else {
      above.forEach(v => L.push('            ' + v));
    }
    base += e.frames;
  });
  L.push('          </spine>');
  L.push('        </sequence>');
  L.push('      </project>');
  L.push('    </event>');
  L.push('  </library>');
  L.push('</fcpxml>');
  return L.join('\n') + '\n';
}

function fcpMultiReadme(entries, w, h) {
  let at = 0;
  const rows = entries.map(e => {
    const line = '  ' + fmtTime(at / state.fps).padStart(8) + '  ' + e.name;
    at += e.frames;
    return line;
  });
  return [
    'Lip Sync Generator v' + APP_VERSION + ' — the whole queue as one Final Cut project',
    '',
    'all-clips.fcpxml holds every clip in the order they were loaded, laid end',
    'to end at ' + w + '×' + h + ', ' + state.fps + ' fps. Each clip keeps its own mouth art,',
    'in the folder named after it. Keep the .fcpxml and those folders together.',
    '',
    'File > Import > XML in Final Cut, then paste the clips over your footage.',
    'If the clips show as missing, File > Relink Files reconnects them at once.',
    '',
    ...(fcpWrapCompound() ? [
      'Each clip is a compound clip on the timeline, named after the file it came',
      'from, so you can slide one speaker\'s line about without picking up dozens',
      'of one-frame pieces. Double-click one to edit the shapes inside it, or',
      'Clip > Break Apart Clip Items to lay them out loose.',
      '',
    ] : []),
    'Running order',
    ...rows,
    '',
    'Total: ' + fmtTime(at / state.fps) + ' over ' + entries.length + ' clips.',
    '',
    'The voice tracks are not on this timeline — only the mouths. Line each clip',
    'up against your own audio, or export the clips with their audio ticked and',
    'drop the WAVs in yourself.'
  ].join('\n');
}

function fcpReadme(w, h, folder, pup, aud) {
  const rel = !folder;
  const n = VIS.length;
  const u = usedVisemes();
  const shapes = n + ' transparent PNG' + (n === 1 ? '' : 's');
  return [
    'Lip Sync Generator v' + APP_VERSION + ' — Final Cut Pro project',
    '',
    'Contents',
    '  <name>.fcpxml   the project: one clip per run of frames',
    '  mouths/         ' + shapes + ', ' + w + ' x ' + h + ', one per mouth shape',
    ...(pup ? ['  puppet/         the picture the mouths go on, on the spine beneath them'] : []),
    ...(aud ? ['  ' + (aud.rel + '                    ').slice(0, 16) +
               'the voice track, already on the timeline'] : []),
    '',
    'To use it',
    '  1. Unzip this folder somewhere you will keep it. Keep the .fcpxml and the',
    '     mouths folder together — the project points at the PNGs by name.',
    '  2. In Final Cut Pro: File > Import > XML, and choose the .fcpxml.',
    ...(pup ? [
      '  3. A project appears in a new event. Open it and the puppet is on the',
      '     storyline with the mouths connected above it, already lined up.',
    ] : [
      '  3. A project appears in a new event. Open it, select everything in the',
      '     timeline, and paste it above your own footage.',
    ]),
    '',
    ...(aud ? [
      'The voice track',
      '  It is in the project already, connected below the mouths at 00:00, so',
      '  there is nothing to drag in. Keep it in this folder with the rest —',
      '  the project points at it by name, the same way it points at the PNGs.',
      '',
    ] : []),
    ...(pup ? [
      'The puppet',
      '  It sits on the spine with its audio switched off at the source, so there',
      '  is no fader to find and nothing to mute by hand. The mouths are connected',
      '  clips above it: drag the puppet and they travel with it, or select the',
      '  mouths alone to nudge the placement.',
      ...(pup.short ? [
        '',
        '  Your puppet is shorter than the take, so the storyline runs out and the',
        '  rest is a gap. The app itself plays a short puppet out and back again;',
        '  a project cannot say that in one clip. To match it, copy the puppet,',
        '  paste it into the gap, and reverse the copy (Retime > Reverse Clip).',
      ] : []),
      '',
    ] : []),
    ...(fcpWrapCompound() ? [
      'It comes as a compound clip',
      '  The run of mouths is wrapped in a single compound clip, so it moves,',
      '  trims and stacks as one item instead of dozens of one-frame pieces.',
      '  To get at an individual shape, double-click it to open the compound and',
      '  edit inside; Clip > Break Apart Clip Items lays the pieces back out on',
      '  the timeline if you would rather have them loose.',
      '',
    ] : []),
    (rel
      ? 'The PNG paths are relative to the .fcpxml, so this works as long as the two\nstay together. If Final Cut shows the clips as missing, use File > Relink\nFiles, point it at the mouths folder, and all ' + n + ' reconnect at once.'
      : 'The PNG paths are absolute, pointing inside:\n  ' + folder + '\nPut the mouths folder there and the clips connect on import. If you move it,\nuse File > Relink Files and point Final Cut at the new location.'),
    '',
    'Fixing a mouth by hand',
    (u.length === n
      ? '  All ' + n + ' shapes are here, and this take used every one of them.'
      : '  All ' + n + ' shapes are in mouths/, not only the ' + u.length + ' this take used. The\n' +
        '  timeline places the ' + u.length + ' it needs; the spares (' +
          VIS.filter(v => !u.includes(v)).join(' ') + ') are there so you can\n' +
        '  correct a frame later without exporting again. To bring one in:\n' +
        '  File > Import > Media, choose it out of mouths/, then drop it on the\n' +
        '  timeline over the clip you want to replace.'),
    '',
    'About the frames',
    '  The PNGs are full-frame and transparent, ' + w + ' x ' + h + ', with the mouth',
    '  already at the position, size and angle you set. Nothing needs a transform',
    '  in Final Cut: drop the clips over your footage at 100% and they line up.',
    '',
    'The timeline runs at ' + state.fps + ' fps. Cutting it into a project at a different',
    'rate will make Final Cut conform it, which moves the sync.',
    ...(patch.on ? ['',
      'The blur patch is not in here. A transparent PNG has nothing underneath',
      'it to blur, so the patch only exists in the video export. In Final Cut,',
      'add a Censor or Gaussian effect to your own footage under these clips.',
    ] : []),
  ].join('\n') + '\n';
}

async function exportFcpxml(sink) {
  const { w, h } = fcpFrameSize();
  const folder = ($('fcpFolder').value || '').trim();
  const base = exportName('fcp');
  setBusy(true, 0);
  try {
    // Every shape at the resting placement, so a frame can be fixed by hand
    // later — not only the ones this take happened to use.
    // (`at` is not called `base`: an earlier version shadowed the filename
    // with the pose and wrote the zip out as [object Object].zip.)
    const files = [];
    const at = pose();
    let done = 0;
    for (let i = 0; i < VIS.length; i++) {
      files.push({ name: 'mouths/mouth-' + VIS[i] + '.png',
                   data: await fcpFramePng(w, h, VIS[i], at) });
      setBusy(true, (++done) / VIS.length * 0.85);
    }
    // The puppet travels as itself, beside the stills, and goes on the spine
    // with the mouths connected above it.
    let pup = plateOn('fcpPlate') ? fcpPuppetInfo() : null;
    if (pup) {
      try {
        const got = await fcpPuppetBytes(pup);
        if (got.baked) {
          pup.rel = pup.rel.replace(/(\.[^.]+)?$/, '') + '-placed.png';
          pup.baked = true;
        }
        files.push({ name: pup.rel, data: got.data });
      } catch (e) {
        // A File handle that has gone stale — the user moved the picture since
        // they chose it — is a reason to write the project without the puppet,
        // not a reason to write no project.
        console.warn('puppet unreadable, project written without it', e);
        toast('The puppet file could not be read, so the project has the mouths only.', 4600);
        pup = null;
      }
    }
    const enc = new TextEncoder();
    // The voice has to be known BEFORE the document is written, because ticking
    // the box now puts it on the timeline rather than merely in the zip.
    const voice = await audioSidecar('audFcp');
    const aud = fcpAudioInfo(voice);
    files.push({ name: base + '.fcpxml',
                 data: enc.encode(fcpxmlDoc({ w, h, folder, puppet: pup, audio: aud })) });
    files.push({ name: 'README.txt', data: enc.encode(fcpReadme(w, h, folder, pup, aud)) });
    if (voice) files.push(voice);
    setBusy(true, .95);
    await emit(sink, base + '.zip', 'final-cut', files);
    toast('Final Cut project written — ' + runs().length + ' clips over ' +
          state.frames.length + ' frames.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Export failed: ' + (e.message || e), 4000);
  }
  setBusy(false);
}

async function exportSequence(sink) {
  const size = parseInt($('outSize').value, 10);
  const withPlate = !!($('seqPlate') && $('seqPlate').checked && hasPlate());
  setBusy(true, 0);
  try {
    const pad = String(state.frames.length).length + 1;
    const nm = i => 'frames/mouth_' + String(i + 1).padStart(pad, '0') + '.png';
    let files;
    if (withPlate) {
      // One PNG per frame with the puppet under the mouth, at the puppet's own
      // size and on a transparent ground. Unlike the mouth-only sequence these
      // cannot be nine pictures repeated — every frame is different.
      const fz = plateFrameSize();
      const c = document.createElement('canvas');
      c.width = fz.w; c.height = fz.h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      files = [];
      for (let i = 0; i < state.frames.length; i++) {
        await composePlateFrame(ctx, fz.w, fz.h, i / state.fps, null, fxOpt('seqFx'));
        files.push({ name: nm(i), data: await canvasPng(c) });
        if (i % 4 === 0) {
          setBusy(true, (i / state.frames.length) * 0.75);
          await new Promise(r => setTimeout(r, 0));
        }
      }
    } else {
      const chart = await renderChart(size, p => setBusy(true, p * 0.5));
      files = state.frames.map((f, i) => ({ name: nm(i), data: chart[f.v] }));
    }
    const enc = new TextEncoder();
    files.push({ name: 'timing.csv', data: enc.encode(timingCSV()) });
    files.push({ name: 'README.txt', data: enc.encode(readme(size)) });
    const voice = await audioSidecar('audSeq');
    if (voice) files.push(voice);
    setBusy(true, .8);
    await new Promise(r => setTimeout(r, 16));
    setBusy(true, .98);
    const total = files.reduce((n, f) => n + (f.data.length || f.data.byteLength || 0), 0);
    await emit(sink, exportName('seq') + '.zip', 'frames', files);
    toast('Exported ' + state.frames.length.toLocaleString() + ' frames · ' + fmtBytes(total) + '.');
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + (e.message || e), 4000);
  }
  setBusy(false);
}

async function exportSprite(sink) {
  const size = parseInt($('outSize').value, 10);
  const withPlate = plateOn('spritePlate');
  const wasPlaying = playing;
  if (withPlate && playing) player.pause();
  const resumeAt = player.currentTime;
  setBusy(true, .3);
  try {
    const { bytes, atlas } = await makeSpriteSheet(size);
    atlas.fps = state.fps;
    atlas.runs = runs();
    const base = exportName('sprite');
    if (download.mode === 'artifact') {
      await deliver(base + '.png', bytes);
      await deliver(base + '-atlas.json', JSON.stringify(atlas, null, 2));
    } else {
      const enc = new TextEncoder();
      const spriteFiles = [
        { name: 'mouth-sprites.png', data: bytes },
        { name: 'atlas.json', data: enc.encode(JSON.stringify(atlas, null, 2)) },
        { name: 'timing.csv', data: enc.encode(timingCSV()) },
        { name: 'README.txt', data: enc.encode(readme(size)) }
      ];
      const voice = await audioSidecar('audSprite');
      if (voice) spriteFiles.push(voice);
      await emit(sink, base + '.zip', 'sprites', spriteFiles);
    }
    toast(withPlate
      ? 'Sprite sheet exported with the puppet · ' + atlas.cells.length + ' cells at ' +
        atlas.frameWidth + '×' + atlas.frameHeight + '.'
      : 'Sprite sheet exported.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Export failed: ' + (e.message || e), 4000);
  }
  if (withPlate) { try { player.currentTime = resumeAt; if (wasPlaying) await player.play(); } catch (e) {} }
  setBusy(false);
}

/* ---- animated GIF, transparent ------------------------------------------

   GIF transparency is one palette index, not an alpha channel: a pixel is
   either fully there or fully gone. So the soft edge the mouth is drawn with
   has to be decided one pixel at a time — anything at or above the cutoff is
   kept at full strength, the rest is dropped. That is the format, not a
   shortcut; a GIF cannot fade an edge into whatever is behind it.

   Everything else here is the 89a container: one global palette built from the
   nine shapes, one frame per run of identical frames, and the Netscape block
   that makes it loop.
--------------------------------------------------------------------------- */

/* Median cut over a 5-bit histogram. Nine drawings share a palette, so the
   whole animation can use one table and every frame stays a plain index map. */
/** Count one picture into a 15-bit colour histogram. Separated out so the
    puppet path can feed frames in one at a time and throw each away: a GIF of
    a whole picture is dozens of frames at the puppet's size, and holding them
    all as RGBA to hand to gifPalette is a hundred megabytes and a dead tab on
    the iPads this is meant to run on. */
function gifCount(hist, im, alphaCut) {
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < alphaCut) continue;
    hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
  }
}

function gifPalette(images, alphaCut, want) {
  const hist = new Uint32Array(32768);
  for (const im of images) gifCount(hist, im, alphaCut);
  return gifPaletteFrom(hist, want);
}

function gifPaletteFrom(hist, want) {
  const bins = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) bins.push(k);
  if (!bins.length) return [[0, 0, 0]];

  const boxOf = list => {
    let lo = [31, 31, 31], hi = [0, 0, 0], n = 0;
    for (const k of list) {
      const c = [(k >> 10) & 31, (k >> 5) & 31, k & 31];
      for (let a = 0; a < 3; a++) { if (c[a] < lo[a]) lo[a] = c[a]; if (c[a] > hi[a]) hi[a] = c[a]; }
      n += hist[k];
    }
    return { list, lo, hi, n, span: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
  };

  let boxes = [boxOf(bins)];
  while (boxes.length < want) {
    // Split the box that is both wide and busy; a box of one colour cannot go.
    let pick = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.list.length < 2 || b.span === 0) continue;
      const score = b.span * Math.log(b.n + 1);
      if (score > best) { best = score; pick = i; }
    }
    if (pick < 0) break;
    const b = boxes[pick];
    const ax = b.hi[0] - b.lo[0] >= b.hi[1] - b.lo[1] && b.hi[0] - b.lo[0] >= b.hi[2] - b.lo[2] ? 0
             : b.hi[1] - b.lo[1] >= b.hi[2] - b.lo[2] ? 1 : 2;
    const sh = ax === 0 ? 10 : ax === 1 ? 5 : 0;
    const sorted = b.list.slice().sort((p, q) => ((p >> sh) & 31) - ((q >> sh) & 31));
    // Cut at the weighted median, so a big flat area does not get one entry
    // and the speckle around it get the rest.
    let half = b.n / 2, run = 0, cut = 0;
    for (; cut < sorted.length - 1; cut++) { run += hist[sorted[cut]]; if (run >= half) break; }
    if (cut < 1) cut = 1;
    if (cut > sorted.length - 1) cut = sorted.length - 1;
    boxes.splice(pick, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)));
  }

  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const k of b.list) {
      const w = hist[k];
      r += (((k >> 10) & 31) * 8 + 4) * w;
      g += (((k >> 5) & 31) * 8 + 4) * w;
      bl += ((k & 31) * 8 + 4) * w;
      n += w;
    }
    return [Math.min(255, Math.round(r / n)), Math.min(255, Math.round(g / n)),
            Math.min(255, Math.round(bl / n))];
  });
}

/** Nearest palette entry, cached per 5-bit colour so a megapixel frame costs
    one search per distinct colour rather than one per pixel. */
function gifMapper(palette, firstIndex) {
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let got = cache[key];
    if (got >= 0) return got;
    let best = 0, bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr * 3 + dg * dg * 6 + db * db;   // eye weighting
      if (d < bd) { bd = d; best = i; }
    }
    got = best + firstIndex;
    cache[key] = got;
    return got;
  };
}

/* The LZW half. The code size grows when the next free code passes 1 << size —
   the rule real decoders implement; growing one code earlier produces a file
   that libgif and Pillow both refuse. */
function gifLzw(indices, minCodeSize) {
  const out = [];
  let cur = 0, bits = 0;
  const put = (code, size) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; }
  };
  const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1, next = EOI + 1, table = new Map();
  put(CLEAR, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k, found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    put(prefix, codeSize);
    table.set(key, next++);
    if (next === 4096) {
      put(CLEAR, codeSize);
      table = new Map(); next = EOI + 1; codeSize = minCodeSize + 1;
    } else if (next > (1 << codeSize) && codeSize < 12) {
      codeSize++;
    }
    prefix = k;
  }
  put(prefix, codeSize);
  put(EOI, codeSize);
  if (bits > 0) out.push(cur & 255);
  return out;
}

function gifBlocks(bytes, push) {
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    push(n);
    for (let j = 0; j < n; j++) push(bytes[i + j]);
  }
  push(0);
}

/** frames: [{ index: Uint8Array, delay: centiseconds }] over one palette. */
function gifBytes(frames, palette, w, h, transparent, loop) {
  let bitsPerPixel = 1;
  while ((1 << bitsPerPixel) < palette.length) bitsPerPixel++;
  const tableSize = 1 << bitsPerPixel;
  const out = [];
  const push = b => out.push(b & 255);
  const push16 = n => { push(n); push(n >> 8); };

  for (const ch of 'GIF89a') push(ch.charCodeAt(0));
  push16(w); push16(h);
  push(0x80 | 0x70 | (bitsPerPixel - 1));   // global table, 8-bit source colour
  push(transparent); push(0);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    push(c[0]); push(c[1]); push(c[2]);
  }
  if (loop) {
    push(0x21); push(0xFF); push(0x0B);
    for (const ch of 'NETSCAPE2.0') push(ch.charCodeAt(0));
    push(0x03); push(0x01); push16(0); push(0);
  }
  const mcs = Math.max(2, bitsPerPixel);
  for (const f of frames) {
    // `hold` is a frame that changes nothing: a single transparent pixel, left
    // in place. It is what makes a constant frame rate affordable — see the
    // note above gifFrames. `clear` is the last hold of a run, which disposes
    // to background over the whole canvas so the next picture starts clean.
    const rect = f.hold && !f.clear;
    const dispose = f.hold && !f.clear ? 1 : f.hold ? 2 : (f.next ? 1 : 2);
    push(0x21); push(0xF9); push(0x04);
    push((dispose << 2) | 1);                 // transparent colour is on
    push16(f.delay); push(transparent); push(0);
    const fw = rect ? 1 : w, fh = rect ? 1 : h;
    push(0x2C); push16(0); push16(0); push16(fw); push16(fh); push(0);
    push(mcs);
    gifBlocks(gifLzw(f.index || new Uint8Array(fw * fh), mcs), push);
  }
  push(0x3B);
  return new Uint8Array(out);
}

const GIF_ALPHA_CUT = 128;

function gifImageData(size, v) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  paintMouth(ctx, size, size, v, state.style);
  return ctx.getImageData(0, 0, size, size);
}

/* --- never round a delay UP -------------------------------------------------

   Runs of identical frames become one frame with a longer delay. The question
   is what to do about a frame rate a hundredth of a second cannot express:
   12 fps is 8.3333cs a frame, and a GIF has nowhere to put the third of a
   hundredth.

   The first version rounded to nearest and carried the remainder into the next
   delay, so the TOTAL came out right to a hundredth of a second. Played in a
   browser that was correct. Imported into an editor it was 14% long, and the
   reason is worth keeping:

     an editor conforms each frame to its own grid by rounding UP. A two-frame
     run written as 17cs is 0.17s, which is 2.04 frames at 12 fps, which becomes
     THREE. Written as 16cs it is 1.92 frames, which becomes two. Half the runs
     in a take gain a whole frame that way, and the drift is one-directional.

   So every delay is now the true length rounded DOWN. Each run is at most its
   own length and more than one frame less, which is exactly the condition for
   an editor's rounding-up to land on the right number. The cost is that the
   total is short by up to a hundredth of a second per run — about a frame over
   a long take, in a player that honours the delays exactly — and that is the
   better side to be wrong on, because it does not accumulate into a visible
   offset the way a whole frame per run does.

   The animated PNG does not have this problem at all: it carries its own
   denominator, so it is written in frames over the frame rate and is exact.
   See `apngBytes`. */
function gifDelays() {
  return runs().map(r => ({
    viseme: r.viseme,
    frames: r.frames,
    startFrame: r.startFrame,
    delay: Math.max(2, Math.floor(r.frames * 100 / state.fps))
  }));
}

/* --- and then: a constant frame rate is the only thing that travels ----------

   Flooring the delays fixed an editor whose timeline ran at the CLIP's rate.
   It did nothing for one whose timeline ran at some other rate, which is the
   normal case — twelve-frame animation cut onto a 25 fps sequence — and there
   the drift came back at about the same size.

   The reason is that a run written as one long frame makes the file
   VARIABLE-frame-rate, and an editor has no choice but to place each of those
   frames on its own grid, rounding up. A third of a hundredth of a second
   becomes a whole frame of the timeline, once per run, and it only ever goes
   one way. No rounding rule fixes that, because the grid being rounded to is
   not ours to know.

   What travels is a file that looks like any other clip: every frame the same
   length, the rate declared. An editor conforms that the way it conforms a
   12 fps movie on a 25 fps timeline — by repeating frames, keeping the
   duration — rather than by adding up rounded pieces.

   So runs are no longer coalesced into long frames. There is one frame per
   frame of the take, and a held shape is a HOLD frame: a single transparent
   pixel that changes nothing, twenty-odd bytes, left in place. The file is
   constant-rate and barely larger than the coalesced one.

   The GIF has one more wrinkle. Its delays are whole hundredths of a second,
   and 12 fps is 8.3333 of them — not expressible, constant or otherwise. So
   the GIF is rendered at the nearest rate a hundredth CAN express (8cs, or
   12.5 fps) and the mouth track is sampled at that rate rather than copied
   frame for frame. The total then comes out exactly right, every frame is the
   same length, and no frame is more than half a frame from where it would have
   been. The animated PNG needs none of this: its denominator is ours to choose,
   so it is written as 1/fps and is exact.
--------------------------------------------------------------------------- */

/** The rate a GIF should be written at, given the take's. A hundredth of a
    second is the only unit a GIF has. */
function gifRate() {
  const cs = Math.max(2, Math.round(100 / state.fps));
  return { cs, fps: 100 / cs };
}

/** One entry per frame of the finished animation, in order.

      v      which mouth shape
      frame  the frame of the take it was sampled from
      hold   true when it is the same picture as the one before it
      clear  true on the last hold of a run (the GIF needs to know)

    `rate` is the rate these are to be played at, which is the take's rate for
    an APNG and the nearest hundredth-expressible one for a GIF. */
function animFrames(rate) {
  const fps = state.fps;
  const n = state.frames.length;
  if (!n) return [];
  const count = Math.max(1, Math.round((n / fps) * rate));
  const out = [];
  for (let i = 0; i < count; i++) {
    // Sample at the middle of the output frame, so a shape that spans the
    // boundary lands on whichever side it mostly covers.
    const src = Math.min(n - 1, Math.floor(((i + 0.5) / rate) * fps));
    const v = state.frames[src].v;
    const prev = out[out.length - 1];
    out.push({ v, frame: src, hold: !!prev && prev.v === v, clear: false });
  }
  // Mark the last hold of each run, which is where the GIF clears the canvas
  // so the next picture is not laid over the previous one.
  for (let i = 0; i < out.length; i++) {
    const last = i === out.length - 1 || out[i + 1].v !== out[i].v;
    if (last && out[i].hold) out[i].clear = true;
  }
  return out;
}

/* Measured rather than guessed: on this art the cost per GIF frame tracks the
   edge, not the area, so it goes with `size` and not `size²` — a 256px take
   came out at ~850 bytes a frame and the same take at 512px at ~1750. */
function gifEstimate(size) {
  // A picture per run, plus a cheap hold frame for every frame that repeats one.
  const frames = Math.max(1, Math.round(state.frames.length / state.fps * gifRate().fps));
  return runs().length * size * 3.4 + frames * 24 + 1200;
}

/** The plate GIF's long edge. Deliberately its own number rather than the
    chosen output size: a GIF is a palette format that stores every frame whole,
    and a 2048px one of a whole picture is tens of megabytes before it is any
    use to anybody. The animated PNG is the export for a full-size picture. */
const GIF_PLATE_MAX = 800;

/** And a total pixel budget across the whole animation, which is what actually
    decides the size once the puppet moves: a constant-rate GIF of a video
    puppet is one real picture per frame, and eight hundred pixels across a
    ninety-second take is a file nobody can use. The long edge comes down until
    the whole thing fits. */
const GIF_PLATE_BUDGET = 800 * 800 * 40;

/** The GIF with the puppet in it. Every frame is its own picture — a video
    puppet moves under the mouth — so the nine-drawings-reused trick the
    mouth-only path uses does not apply, and the whole run is quantised against
    one palette so nothing shifts colour between frames. */
async function exportGifPlate(sink, loop) {
  const rate = gifRate();
  const seq = animFrames(rate.fps);
  // A still puppet that is not being moved draws the same picture for the same
  // shape, so a held frame is a hold and only the distinct pictures are ever
  // composed. A video puppet, or a keyframed move, is different every frame:
  // no holds, and one composed picture per frame of the animation. That is a
  // lot of pixels, so the long edge comes down as the count goes up.
  const moving = everyFrameDiffers();
  const real = moving ? seq.length : seq.filter(f => !f.hold).length;
  const budget = Math.sqrt(GIF_PLATE_BUDGET / Math.max(1, real));
  const long = Math.min(GIF_PLATE_MAX, parseInt($('outSize').value, 10),
                        Math.max(160, Math.round(budget)));
  const fz = plateCellSize(long);
  const c = document.createElement('canvas');
  c.width = fz.w; c.height = fz.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const frameAt = async (i) => {
    const f = seq[i];
    if (!moving && cache.has(f.v)) return cache.get(f.v);
    await composePlateFrame(ctx, fz.w, fz.h, f.frame / state.fps, null, fxOpt('gifFx'));
    const im = ctx.getImageData(0, 0, fz.w, fz.h);
    if (!moving) cache.set(f.v, im);
    return im;
  };

  // Pass one: the palette, counting each picture and letting it go. Holds are
  // skipped — they are the picture before them, already counted.
  const hist = new Uint32Array(32768);
  for (let i = 0; i < seq.length; i++) {
    if (!moving && seq[i].hold) continue;
    gifCount(hist, await frameAt(i), GIF_ALPHA_CUT);
    if ((i & 7) === 7) { setBusy(true, (i / seq.length) * 0.40); await new Promise(r => setTimeout(r, 0)); }
  }
  const palette = gifPaletteFrom(hist, 255);
  const map = gifMapper(palette, 1);
  const table = [[0, 0, 0]].concat(palette);

  // Pass two: index them. One byte a pixel instead of four, which is what makes
  // holding the whole run affordable.
  const n = fz.w * fz.h;
  const blank = new Uint8Array(n);
  const frames = [];
  for (let i = 0; i < seq.length; i++) {
    const f = seq[i];
    if (!moving && f.hold) {
      frames.push(f.clear ? { hold: true, clear: true, index: blank, delay: rate.cs }
                          : { hold: true, delay: rate.cs });
    } else {
      const d = (await frameAt(i)).data;
      const idx = new Uint8Array(n);
      for (let q = 0, o = 0; q < n; q++, o += 4) {
        idx[q] = d[o + 3] < GIF_ALPHA_CUT ? 0 : map(d[o], d[o + 1], d[o + 2]);
      }
      frames.push({ index: idx, delay: rate.cs,
                    next: !moving && i + 1 < seq.length && seq[i + 1].hold });
    }
    if ((i & 7) === 7) { setBusy(true, 0.40 + (i / seq.length) * 0.52); await new Promise(r => setTimeout(r, 0)); }
  }
  return { bytes: gifBytes(frames, table, fz.w, fz.h, 0, loop), count: frames.length, fz };
}

async function exportGif(sink) {
  const size = parseInt($('outSize').value, 10);
  const loop = $('gifLoop').checked;
  const withPlate = plateOn('gifPlate');
  const wasPlaying = playing;
  if (withPlate && playing) player.pause();
  const resumeAt = player.currentTime;
  setBusy(true, 0);
  try {
    if (withPlate) {
      const { bytes, count, fz } = await exportGifPlate(sink, loop);
      setBusy(true, .98);
      const stem = exportName('gif');
      const voice = await audioSidecar('audGif');
      const out = [{ name: stem + '.gif', data: bytes }];
      if (voice) out.push(voice);
      if (Array.isArray(sink)) {
        const at = sink.prefix ? 'gif/' : '';
        out.forEach(f => sink.push({ name: at + f.name, data: f.data }));
      } else if (voice) {
        await deliver(stem + '.zip', makeZip(out));
      } else {
        await deliver(stem + '.gif', bytes);
      }
      toast('GIF exported with the puppet · ' + count + ' frames at ' + fz.w + '×' + fz.h +
            ' · ' + fmtBytes(bytes.length) + '.');
      try { player.currentTime = resumeAt; if (wasPlaying) await player.play(); } catch (e) {}
      setBusy(false);
      return;
    }
    const images = {};
    for (let i = 0; i < VIS.length; i++) {
      images[VIS[i]] = gifImageData(size, VIS[i]);
      setBusy(true, (i + 1) / VIS.length * 0.3);
      await new Promise(r => setTimeout(r, 0));
    }
    // Index 0 is the hole; the drawn colours start at 1.
    const palette = gifPalette(Object.values(images), GIF_ALPHA_CUT, 255);
    const map = gifMapper(palette, 1);
    const table = [[0, 0, 0]].concat(palette);
    setBusy(true, .4);

    const indexed = {};
    for (const v of VIS) {
      const d = images[v].data, n = size * size, idx = new Uint8Array(n);
      for (let p = 0, q = 0; p < n; p++, q += 4) {
        idx[p] = d[q + 3] < GIF_ALPHA_CUT ? 0 : map(d[q], d[q + 1], d[q + 2]);
      }
      indexed[v] = idx;
      await new Promise(r => setTimeout(r, 0));
    }
    setBusy(true, .55);

    const rate = gifRate();
    const seq = animFrames(rate.fps);
    const blank = new Uint8Array(size * size);     // index 0 is the transparent hole
    const frames = [];
    for (let i = 0; i < seq.length; i++) {
      const f = seq[i];
      frames.push(f.hold && !f.clear
        ? { hold: true, delay: rate.cs }
        : f.hold
          ? { hold: true, clear: true, index: blank, delay: rate.cs }
          : { index: indexed[f.v], delay: rate.cs,
              next: i + 1 < seq.length && seq[i + 1].hold });
      if (i % 40 === 0) {
        setBusy(true, .55 + (i / seq.length) * 0.4);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    const bytes = gifBytes(frames, table, size, size, 0, loop);
    setBusy(true, .98);
    const stem = exportName('gif');
    // A bare .gif unless the voice track is coming too, in which case there
    // has to be something to hold both.
    const voice = await audioSidecar('audGif');
    const gifFiles = [{ name: stem + '.gif', data: bytes }];
    if (voice) gifFiles.push(voice);
    if (Array.isArray(sink)) {
      const at = sink.prefix ? 'gif/' : '';
      gifFiles.forEach(f => sink.push({ name: at + f.name, data: f.data }));
    } else if (voice) {
      await deliver(stem + '.zip', makeZip(gifFiles));
    } else {
      await deliver(stem + '.gif', bytes);
    }
    toast('GIF exported · ' + frames.length + ' frames · ' + fmtBytes(bytes.length) + '.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Export failed: ' + (e.message || e), 4000);
  }
  if (withPlate) { try { player.currentTime = resumeAt; if (wasPlaying) await player.play(); } catch (e) {} }
  setBusy(false);
}

/** A whole frame: the puppet, then the blur patch, then the mouth — at the
    puppet's own size and on a transparent ground, so a cut-out puppet stays
    cut out. This is the answer to "keep the transparency if you can": a PNG
    can, an MP4 cannot, and the two exports that use this are the two that can.

    Sized off the plate rather than the square the mouth-only exports use,
    because a frame with a puppet in it is a picture of a puppet, not a mouth. */
const PLATE_FRAME_MAX = 1600;

function plateFrameSize() { return plateCellSize(PLATE_FRAME_MAX); }

/** The plate's shape at a given long edge. Every export that carries the puppet
    works at the puppet's own proportions rather than the square the mouth-only
    exports use — a frame with a puppet in it is a picture of a puppet — and they
    differ only in how big they can afford to be. */
function plateCellSize(long) {
  const pz = frameHasContent() ? frameSize() : null;
  if (!pz) return null;
  const s = Math.min(1, long / Math.max(pz.w, pz.h));
  return { w: Math.max(2, Math.round(pz.w * s)), h: Math.max(2, Math.round(pz.h * s)) };
}

let plateScratch = null;
function plateScratchCanvas(W, H) {
  if (!plateScratch) plateScratch = document.createElement('canvas');
  if (plateScratch.width !== W || plateScratch.height !== H) {
    plateScratch.width = W; plateScratch.height = H;
  }
  const c = plateScratch.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  return { el: plateScratch, ctx: c };
}

/** One frame of the whole stack, for every export that wants a flat picture.

    Kept under its old name because five exports call it, but it is no longer
    "the plate and the mouth" — it walks the layer list, in order, and the
    plate is simply the layer that needs an await in the middle of it. The
    plate is rendered to a scratch canvas first for exactly that reason:
    everything else is synchronous, and interleaving one await into the walk
    would make the whole compositor async for one case.

    `bg` is for the formats that cannot hold transparency: the chroma-key MP4
    wants the key colour behind a cut-out puppet, not black, or the cut-out
    arrives with a black halo that no keyer will lift. */
async function composePlateFrame(ctx, W, H, t, bg, opts) {
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  else ctx.clearRect(0, 0, W, H);
  const fi = clamp(Math.floor(t * state.fps), 0, Math.max(0, state.frames.length - 1));
  let plate = null;
  const pl = plateLayer();
  if (pl && pl.visible && hasPlate()) {
    plate = plateScratchCanvas(W, H);
    await drawPlateFrame(plate.ctx, W, H, t);
  }
  compositeLayers(ctx, W, H, {
    frame: fi,
    pose: poseAt(fi),
    noExtras: !!(opts && opts.noExtras),
    noFx: !!(opts && opts.noFx),
    drawPlate: c => { if (plate) c.drawImage(plate.el, 0, 0); }
  });
}

/* ---- animated PNG ----------------------------------------------------------

   The same nine drawings as the GIF, in the one animated format that keeps the
   alpha the GIF throws away. A GIF's transparency is a single palette entry — a
   pixel is either there or it is not — so every soft edge on a mouth becomes a
   staircase, and the picture is cut to 255 colours on the way past. An APNG is
   PNG frames end to end: eight bits of alpha, every colour, no matte.

   Nothing here needs a codec, which is the point. HEVC with an alpha channel
   would be the file to hand an iPad animation app, and a browser cannot make
   one: Chromium answers "Alpha encoding is not currently supported" to every
   codec it has, and Apple's HEVC-with-alpha is made by Apple's own tools.
   Deflate and a handful of chunk headers are something a page can do on its own.
--------------------------------------------------------------------------- */

/** One PNG chunk: length, type, payload, CRC of type+payload. */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG scanline filtering. Each row is tried through all four filters this
    encoder writes and the one leaving the smallest sum of signed bytes wins —
    the heuristic from the PNG spec itself. On flat cartoon art it is the
    difference between a file and a big file: Up and Paeth cost nothing to try
    and collapse the long runs of identical rows a drawn mouth is mostly made
    of. */
function pngFilter(rgba, w, h) {
  const stride = w * 4;
  const out = new Uint8Array((stride + 1) * h);
  const cand = [0, 1, 2, 3].map(() => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  let prev = zero;
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 4; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0;
        const b = prev[x];
        const q = x >= 4 ? prev[x - 4] : 0;
        let v;
        if (f === 0) v = row[x];
        else if (f === 1) v = row[x] - a;
        else if (f === 2) v = row[x] - b;
        else {
          const p = a + b - q;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - q);
          v = row[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : q);
        }
        const u = v & 255;
        c[x] = u;
        sum += u < 128 ? u : 256 - u;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // 0 None, 1 Sub, 2 Up, 4 Paeth — 3 is Average, which is not written here.
    out[y * (stride + 1)] = best === 3 ? 4 : best;
    out.set(cand[best], y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

/** A zlib stream that does no compressing at all — stored deflate blocks and an
    Adler-32. Only ever reached in a browser without CompressionStream, where a
    big correct file beats no file. */
function zlibStore(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2, p = 0;
  for (let i = 0; i < blocks; i++) {
    const n = Math.min(65535, bytes.length - p);
    const m = (~n) & 0xFFFF;
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = n & 255; out[o++] = n >> 8;
    out[o++] = m & 255; out[o++] = m >> 8;
    out.set(bytes.subarray(p, p + n), o);
    o += n; p += n;
  }
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  new DataView(out.buffer).setUint32(o, ((b << 16) | a) >>> 0);
  return out;
}

async function zlibDeflate(bytes) {
  if (typeof CompressionStream === 'function') {
    try {
      const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) { /* and on to the stored fallback */ }
  }
  return zlibStore(bytes);
}

/** frames: [{data, delay}] — data already a zlib stream of filtered scanlines,
    delay in hundredths of a second. Every frame is the full size and replaces
    what came before, so there is no compositing to get wrong. */
function apngBytes(frames, w, h, loop) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];

  const ihdr = new Uint8Array(13);
  const ih = new DataView(ihdr.buffer);
  ih.setUint32(0, w); ih.setUint32(4, h);
  ihdr[8] = 8;                          // eight bits a channel
  ihdr[9] = 6;                          // truecolour with alpha
  parts.push(pngChunk('IHDR', ihdr));

  const actl = new Uint8Array(8);
  const ac = new DataView(actl.buffer);
  ac.setUint32(0, frames.length);
  ac.setUint32(4, loop ? 0 : 1);        // 0 plays forever
  parts.push(pngChunk('acTL', actl));

  let seq = 0;
  frames.forEach((f, i) => {
    // A hold frame is one transparent pixel in the corner, blended OVER what is
    // already there: it changes nothing and costs about thirty bytes. It is what
    // lets every frame be the same length without the file being one picture per
    // frame of the take. See the note above gifFrames.
    const fw = f.hold ? 1 : w, fh = f.hold ? 1 : h;
    const fc = new Uint8Array(26);
    const d = new DataView(fc.buffer);
    d.setUint32(0, seq++);
    d.setUint32(4, fw); d.setUint32(8, fh);
    d.setUint32(12, 0); d.setUint32(16, 0);
    // An APNG carries its own denominator, so a run of n frames at 12 fps is
    // written as the fraction n/12 and is EXACT — no hundredth-of-a-second
    // rounding, and nothing for an editor conforming the file to its timeline
    // to round up. `den` is the frame rate; `num` is how many frames the shape
    // is held for. Falls back to hundredths if a caller has no frame count.
    d.setUint16(20, Math.max(1, Math.min(65535, f.num != null ? f.num : f.delay)));
    d.setUint16(22, Math.max(1, Math.min(65535, f.den || 100)));
    fc[24] = 0;                         // dispose: leave it
    fc[25] = f.hold ? 1 : 0;            // blend: over for a hold, replace for a picture
    parts.push(pngChunk('fcTL', fc));
    if (i === 0) {
      // The first frame is the still image too, so it goes in as IDAT and any
      // reader that knows nothing about APNG shows it and stops.
      parts.push(pngChunk('IDAT', f.data));
    } else {
      const fd = new Uint8Array(4 + f.data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(f.data, 4);
      parts.push(pngChunk('fdAT', fd));
    }
  });
  parts.push(pngChunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((n, q) => n + q.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  parts.forEach(q => { out.set(q, o); o += q.length; });
  return out;
}

/** Roughly what an APNG will weigh. Every frame carries its own copy of the
    pixels — APNG has no way to say "the one before" — so it is the run count
    times the cost of one picture. The coefficient is measured rather than
    guessed: a frame inside an APNG comes out about a third of a standalone PNG
    of the same drawing, because it is filtered per row and carries none of the
    headers. A 256px take estimated at 183 KB this way weighed 63. */
function apngEstimate(size, perFrame) {
  return gifDelays().length * perFrame * 0.33 + 200;
}

async function exportApng(sink) {
  const size = parseInt($('outSize').value, 10);
  const loop = $('apngLoop').checked;
  const withPlate = !!($('apngPlate') && $('apngPlate').checked && hasPlate());
  setBusy(true, 0);
  try {
    // One frame per frame of the take, every one the same length — see the note
    // above gifFrames for why a constant rate is the thing that survives an
    // import. A held shape costs a thirty-byte hold frame, not a second copy of
    // the picture.
    const seq = animFrames(state.fps);
    let bytes, fw = size, fh = size;
    if (withPlate) {
      // With the puppet in it every frame is its own picture, so nothing can be
      // compressed once and reused — and a moving puppet means even a held
      // mouth shape is a different frame. Runs still set the TIMING.
      const fz = plateFrameSize();
      fw = fz.w; fh = fz.h;
      const c = document.createElement('canvas');
      c.width = fw; c.height = fh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      // A still puppet that is not being moved draws the same picture for the
      // same shape, so a held frame really is a hold. A video puppet, or a
      // keyframed move, is a different picture every frame and gets a real one.
      const movingPlate = everyFrameDiffers();
      const blank = await zlibDeflate(new Uint8Array(5));
      const frames = [];
      for (let i = 0; i < seq.length; i++) {
        if (seq[i].hold && !movingPlate) {
          frames.push({ data: blank, hold: true, num: 1, den: state.fps });
        } else {
          await composePlateFrame(ctx, fw, fh, seq[i].frame / state.fps, null, fxOpt('apngFx'));
          const px = ctx.getImageData(0, 0, fw, fh);
          frames.push({ data: await zlibDeflate(pngFilter(px.data, fw, fh)),
                        num: 1, den: state.fps });
        }
        setBusy(true, (i + 1) / seq.length * 0.9);
        if ((i & 3) === 3) await new Promise(r => setTimeout(r, 0));
      }
      bytes = apngBytes(frames, fw, fh, loop);
    } else {
      const used = [...new Set(seq.map(f => f.v))];
      const data = {};
      for (let i = 0; i < used.length; i++) {
        const img = gifImageData(size, used[i]);
        data[used[i]] = await zlibDeflate(pngFilter(img.data, size, size));
        setBusy(true, (i + 1) / used.length * 0.85);
        await new Promise(r => setTimeout(r, 0));
      }
      const blank = await zlibDeflate(new Uint8Array(5));   // one transparent pixel
      bytes = apngBytes(seq.map(f => f.hold
        ? { data: blank, hold: true, num: 1, den: state.fps }
        : { data: data[f.v], num: 1, den: state.fps }),
        size, size, loop);
    }
    setBusy(true, .98);
    const stem = exportName('apng');
    const voice = await audioSidecar('audApng');
    const files = [{ name: stem + '.png', data: bytes }];
    if (voice) files.push(voice);
    if (Array.isArray(sink)) {
      const at = sink.prefix ? 'apng/' : '';
      files.forEach(f => sink.push({ name: at + f.name, data: f.data }));
    } else if (voice) {
      await deliver(stem + '.zip', makeZip(files));
    } else {
      await deliver(stem + '.png', bytes);
    }
    toast('Animated PNG exported · ' + seq.length + ' frames at ' + fw + '×' + fh +
          ' · ' + fmtBytes(bytes.length) + '.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Export failed: ' + (e.message || e), 4000);
  }
  setBusy(false);
}

/* ---- the conversation, as one continuous piece -------------------------------

   The batch gives you a folder per line. This gives you the scene: every clip
   in the queue, end to end, in one file, with whoever was cast on each line
   wearing their own head and their own mouth.

   END TO END, and not at their source offsets, which took a while to settle.
   A split cuts on the middle of a silence, so half of every pause ends one line
   and half begins the next; butted together they reproduce the original timing
   exactly. Laying them at source offsets instead would faithfully reinstate the
   stretches the user had just DROPPED, which is the opposite of what dropping
   them meant — and it would make no sense at all for clips that came from
   different files.

   One size for the run, taken from the first clip. Every placement in this app
   is a fraction of the frame and the puppet layer keeps its own aspect, so a
   later clip with a differently shaped puppet composes into that frame without
   stretching — it just sits in the middle with transparent air round it. Anyone
   who wants it otherwise sets a canvas, which is what the canvas is for.
--------------------------------------------------------------------------- */

/** Walk the queue, composing every frame of every clip into one canvas.

    `visit(ctx, i, info)` is called once per output frame with the frame already
    drawn. The walk opens each clip for real — the same decode the batch does —
    so what comes out is what you would get by opening each one and exporting
    it yourself. */
async function conversationWalk(long, visit, say) {
  const clips = queue.clips.slice();
  const out = { size: null, frames: 0, skipped: [], audio: [], cast: [] };
  let c = null, ctx = null;
  for (let ci = 0; ci < clips.length; ci++) {
    if (batchAbort) break;
    const clip = clips[ci];
    if (say) say('Line ' + (ci + 1) + ' of ' + clips.length + ' · ' + clip.name);
    await openClip(clip.id, { force: true });
    await awaitPlate();
    if (clip.error || !state.frames.length) {
      out.skipped.push(clip.name + (clip.error ? ' (' + clip.error + ')' : ''));
      continue;
    }
    if (!out.size) {
      out.size = plateCellSize(long) || { w: long, h: long };
      c = document.createElement('canvas');
      c.width = out.size.w; c.height = out.size.h;
      ctx = c.getContext('2d', { willReadFrequently: true });
    }
    const seq = animFrames(state.fps);
    for (let k = 0; k < seq.length; k++) {
      if (batchAbort) break;
      await composePlateFrame(ctx, out.size.w, out.size.h, seq[k].frame / state.fps);
      await visit(ctx, out.frames++, { clip, clipIndex: ci, within: k, of: seq.length });
      if ((k & 7) === 7) await new Promise(r => setTimeout(r, 0));
    }
    // The voice, in the same order, so the picture has something to play
    // against. Collected on the way past rather than in a pass of its own —
    // state.buffer is this clip's kept audio and it is about to be replaced.
    if (state.buffer) out.audio.push(state.buffer);
    out.cast.push({ name: clip.name, who: castLabel(clip.cast), frames: seq.length });
  }
  return out;
}

/** The whole scene's voice as one track, in the order it plays. */
function joinBuffers(bufs) {
  const list = bufs.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const rate = list[0].sampleRate;
  const ch = Math.max(...list.map(b => b.numberOfChannels));
  const total = list.reduce((n, b) => n + b.length, 0);
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const out = new AC(ch, total, rate).createBuffer(ch, total, rate);
  let at = 0;
  list.forEach(b => {
    for (let k = 0; k < ch; k++) {
      // A mono line in a stereo scene plays out of both speakers rather than
      // out of one, which is what a listener expects from a voice.
      const src = b.getChannelData(Math.min(k, b.numberOfChannels - 1));
      out.getChannelData(k).set(src, at);
    }
    at += b.length;
  });
  return out;
}

/** What the run is called, and the note that travels with it. */
function conversationName(ext) {
  const first = queue.clips[0];
  const stem = first ? safeName((first.file.name || 'conversation')
                        .replace(/\.[^.]+$/, '').replace(/-\d+$/, '')) : 'conversation';
  return stem + '-SCENE' + ext;
}

function conversationReadme(out, fmt) {
  const L = [];
  L.push('The whole conversation as one ' + fmt + '.');
  L.push('');
  L.push('Made by Lip Sync Generator v' + APP_VERSION + '.');
  L.push('');
  L.push(out.frames + ' frames at ' + state.fps + ' fps · ' +
         out.size.w + ' × ' + out.size.h);
  L.push('');
  L.push('The lines, in the order they play:');
  let at = 0;
  out.cast.forEach((e, i) => {
    L.push('  ' + String(i + 1).padStart(2, '0') + '. ' + e.name +
           (e.who ? '  —  ' + e.who : '') +
           '   ' + fmtTime(at / state.fps) + ' → ' + fmtTime((at + e.frames) / state.fps));
    at += e.frames;
  });
  if (out.skipped.length) {
    L.push('');
    L.push('Left out, with nothing to render: ' + out.skipped.join(', '));
  }
  L.push('');
  L.push('The clips are butted end to end, not placed at their original');
  L.push('offsets in the source file. A split cuts on the middle of a pause,');
  L.push('so half of each pause ends one line and half begins the next —');
  L.push('end to end reproduces the original timing, and anything that was');
  L.push('dropped stays dropped.');
  L.push('');
  L.push('The frame is ' + out.size.w + ' × ' + out.size.h + ', taken from the');
  L.push('first line. Placements are fractions of the frame, so a line whose');
  L.push('puppet is a different shape sits in the middle of it rather than');
  L.push('being stretched to fit. Set a canvas if you want a particular one.');
  return L.join('\n');
}

/** Roughly how many frames the whole run will be, for the progress bar. The
    clips that have been analysed know exactly; the rest are guessed from their
    duration, which is close enough for a bar. */
function convEstimateFrames() {
  return queue.clips.reduce((n, c) => n +
    (c.frames && c.frames.length ? c.frames.length
                                 : Math.round((c.duration || 0) * state.fps)), 0) || 1;
}

/** The scene as one file.

    APNG takes one walk: every frame is compressed as it is composed and let go
    of, so the memory never holds more than one picture plus the compressed
    run. GIF takes two, because a palette has to be counted across the whole
    animation before any of it can be indexed against it — and a palette taken
    from the first line alone would band every character who came later. Two
    walks is slow and it is honest; the alternative is a scene whose second
    speaker is the wrong colour. */
async function exportConversation(kind) {
  if (batchRunning || queue.clips.length < 2) return;
  batchRunning = true; batchAbort = false;
  $('batchStop').hidden = false;
  updateBatchUI();
  showTab('export');
  const wasPlaying = playing;
  if (playing) player.pause();
  const long = parseInt($('outSize').value, 10);
  const loop = $('convLoop') ? $('convLoop').checked : true;
  const est = convEstimateFrames();
  const walks = kind === 'gif' ? 2 : 1;
  const openAt = queue.activeId;
  setBusy(true, 0);
  try {
    let out, bytes;
    if (kind === 'apng') {
      const frames = [];
      out = await conversationWalk(long, async (ctx, i) => {
        // The canvas is the only thing in scope that knows the run's size:
        // `out` is not assigned until the walk returns.
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const px = ctx.getImageData(0, 0, W, H);
        frames.push({ data: await zlibDeflate(pngFilter(px.data, W, H)),
                      num: 1, den: state.fps });
        setBusy(true, Math.min(0.92, (i / est) * 0.92));
      }, batchSay);
      if (batchAbort || !out.size || !frames.length) throw new Error('nothing to render');
      bytes = apngBytes(frames, out.size.w, out.size.h, loop);
    } else {
      // Pass one: the palette.
      const hist = new Uint32Array(32768);
      const first = await conversationWalk(long, async (ctx, i) => {
        gifCount(hist, ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height),
                 GIF_ALPHA_CUT);
        setBusy(true, Math.min(0.46, (i / est) * 0.46));
      }, m => batchSay('Colours · ' + m));
      if (batchAbort || !first.size) throw new Error('nothing to render');
      const palette = gifPaletteFrom(hist, 255);
      const map = gifMapper(palette, 1);
      const table = [[0, 0, 0]].concat(palette);
      // Pass two: index against it. One byte a pixel, which is what makes
      // holding a whole conversation affordable.
      const n = first.size.w * first.size.h;
      const rate = gifRate();
      const frames = [];
      out = await conversationWalk(long, async (ctx, i) => {
        const d = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
        const idx = new Uint8Array(n);
        for (let q = 0, o = 0; q < n; q++, o += 4) {
          idx[q] = d[o + 3] < GIF_ALPHA_CUT ? 0 : map(d[o], d[o + 1], d[o + 2]);
        }
        frames.push({ index: idx, delay: rate.cs });
        setBusy(true, Math.min(0.92, 0.46 + (i / est) * 0.46));
      }, m => batchSay('Frames · ' + m));
      if (batchAbort || !frames.length) throw new Error('nothing to render');
      bytes = gifBytes(frames, table, out.size.w, out.size.h, 0, loop);
    }
    setBusy(true, 0.95);
    batchSay('Writing the file…');
    const ext = kind === 'apng' ? '.png' : '.gif';
    const files = [{ name: conversationName(ext), data: bytes }];
    const voice = joinBuffers(out.audio);
    if (voice && $('convAudio') && $('convAudio').checked) {
      files.push({ name: conversationName('.wav'), data: wavBytes(voice) });
    }
    files.push({ name: 'README.txt',
                 data: new TextEncoder().encode(conversationReadme(out, kind === 'apng'
                   ? 'animated PNG' : 'GIF')) });
    await paintNow();
    await deliver(conversationName('.zip'), makeZip(files));
    const who = out.cast.filter(e => e.who).length;
    batchSay('Done — ' + out.cast.length + ' lines, ' + out.frames + ' frames.');
    toast('The scene is one ' + (kind === 'apng' ? 'animated PNG' : 'GIF') + ' · ' +
          out.cast.length + ' lines, ' + out.frames + ' frames at ' +
          out.size.w + '×' + out.size.h +
          (who ? ' · ' + who + ' cast' : '') +
          (out.skipped.length ? ' · skipped ' + out.skipped.join(', ') : '') + '.', 7000);
  } catch (e) {
    console.error(e);
    batchSay(batchAbort ? 'Stopped.' : 'Failed: ' + (e.message || e));
    if (!batchAbort) {
      toast(e && e.code === 'declined' ? 'Save cancelled.'
            : 'The scene export failed: ' + (e.message || e), 6000);
    }
  }
  // Put the queue back where it was found. An export that silently moves which
  // clip is open is how a hand edit ends up on the wrong line.
  if (openAt && queue.activeId !== openAt) await openClip(openAt, { force: true });
  batchRunning = false;
  batchAbort = false;
  $('batchStop').hidden = true;
  setBusy(false);
  updateBatchUI();
  if (wasPlaying) { /* left paused: a render is long enough that resuming is a surprise */ }
}

/* ---- exporting the whole queue --------------------------------------------

   One clip at a time, and one zip per clip. Each clip is opened for real —
   decoded, analysed if it never was — so what comes out is exactly what you
   would get by opening it yourself and pressing the same buttons; there is no
   second, quieter code path that could quietly disagree with the first.
--------------------------------------------------------------------------- */

const BATCH_RUNNERS = {
  chart:  { label: 'chart + timing',  slug: 'charts',    run: sink => exportChart(sink) },
  gif:    { label: 'GIF',             slug: 'gifs',      run: sink => exportGif(sink) },
  apng:   { label: 'animated PNG',    slug: 'apng',      run: sink => exportApng(sink) },
  fcp:    { label: 'Final Cut',       slug: 'final-cut', run: sink => exportFcpxml(sink) },
  sprite: { label: 'sprite sheet',    slug: 'sprites',   run: sink => exportSprite(sink) },
  seq:    { label: 'frame sequence',  slug: 'frames',    run: sink => exportSequence(sink) },
  mp4:    { label: 'chroma-key MP4',  slug: 'chroma',    run: sink => exportVideo(sink) },
  // It is the slow one — it renders about as long as the clip runs — but
  // "this card quietly ignores the switch you just set" is worse than slow.
  // Pressing Export with All clips chosen and getting one file back reads as
  // an export that only did the last clip, which is what was reported.
  overlay: { label: 'overlay video', slug: 'overlay', run: sink => exportOverlayVideo(sink) }
};

let batchRunning = false, batchAbort = false;

/** What each card's button says and does.

    The scope lives IN the card, next to the button it governs, rather than once
    at the top of the tab. One control at the top was fewer moving parts and
    read worse: by the time you had scrolled to the Final Cut card you could no
    longer see what it was going to act on. A toggle you have to remember is a
    toggle you will get wrong.

    Each card holds its own, so exporting a batch of GIFs while pulling a single
    Final Cut project for the clip in front of you is just two cards set
    differently, which is a thing people actually want. */
const EXPORT_CARDS = {
  chart:  { btn: 'expChart',  one: 'Export chart + timing',    many: 'Export # chart zips' },
  gif:    { btn: 'expGif',    one: 'Export transparent GIF',   many: 'Export # GIFs' },
  apng:   { btn: 'expApng',   one: 'Export animated PNG',      many: 'Export # animated PNGs' },
  fcp:    { btn: 'expFcp',    one: 'Export Final Cut project', many: 'Export # Final Cut projects' },
  sprite: { btn: 'expSprite', one: 'Export sprite sheet',      many: 'Export # sprite sheets' },
  seq:    { btn: 'expSeq',    one: 'Export PNG frame sequence', many: 'Export # PNG frame sequences' },
  mp4:    { btn: 'expMp4',    one: 'Export chroma-key MP4',    many: 'Export # chroma-key MP4s' },
  overlay:{ btn: 'expOverlay', one: 'Export overlay video',     many: 'Export # overlay videos' }
};

const cardScope = {};                      // key -> 'queue' | 'one'
Object.keys(EXPORT_CARDS).forEach(k => { cardScope[k] = 'queue'; });
const isBatch = key => cardScope[key] === 'queue' && queue.clips.length > 1;
/** True when anything on the tab is set to run the queue — what the shared
    wording (compound clips, the combined project note) keys off. */
const batchMode = () => queue.clips.length > 1 &&
  Object.keys(EXPORT_CARDS).some(k => cardScope[k] === 'queue');

/** The scope toggle that sits in every card, built here rather than written out
    six times in the markup. */
function buildScopeToggles() {
  Object.keys(EXPORT_CARDS).forEach(key => {
    const btn = $(EXPORT_CARDS[key].btn);
    if (!btn || btn.parentNode.querySelector('.scoperow[data-card="' + key + '"]')) return;
    const row = document.createElement('div');
    row.className = 'scoperow card';
    row.dataset.card = key;
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'What this export acts on');
    [['queue', 'Batch Export'], ['one', 'Current Selection Export']].forEach(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scopebtn';
      b.dataset.scope = val;
      b.textContent = label;
      b.setAttribute('role', 'radio');
      b.onclick = () => {
        cardScope[key] = val;
        updateBatchUI();
        updateEstimates();
      };
      row.appendChild(b);
    });
    btn.parentNode.insertBefore(row, btn);
  });
}

function updateBatchUI() {
  const card = $('batchCard');
  if (!card) return;
  const n = queue.clips.length;
  const many = n > 1;
  card.hidden = !many;
  $('batchCount').textContent = many ? n + ' clips' : '';
  const open = activeClip();
  // The master switch, and what it currently says. "Mixed" is a real state —
  // a batch of GIFs and one Final Cut project is a thing people set on
  // purpose — so it is shown rather than silently rounded to one or the other.
  const vals = Object.keys(EXPORT_CARDS).map(k => cardScope[k]);
  const allQueue = vals.every(v => v === 'queue');
  const allOne = vals.every(v => v === 'one');
  const sa = $('scopeAll'), so = $('scopeOne'), sm = $('scopeMixed');
  if (sa && so) {
    sa.textContent = 'All ' + n + ' clips';
    sa.classList.toggle('on', allQueue);
    so.classList.toggle('on', allOne);
    sa.setAttribute('aria-checked', String(allQueue));
    so.setAttribute('aria-checked', String(allOne));
    if (sm) sm.hidden = allQueue || allOne;
  }
  if (many) {
    // What a long clip costs, said before the run rather than reported as a
    // skip after it.
    const longOnes = queue.clips.filter(clipIsLong);
    const longNote = longOnes.length
      ? ' <b>' + (longOnes.length === 1
          ? xmlEsc(longOnes[0].name) + ' runs ' + fmtTime(longOnes[0].duration || 0)
          : longOnes.length + ' of them run over ' + fmtTime(BATCH_MAX_SECONDS)) +
        '</b>, so this run will take a while — it still exports.'
      : '';
    $('batchHint').innerHTML =
      'The switch above sets every box below; a box can still be set on its own. ' +
      '<b>Batch Export</b> runs that format across ' +
      'all ' + n + ' clips — each analysed if it has not been already, exported with its ' +
      'own edits, placement and lip set — and comes down as <b>one zip with a folder per ' +
      'clip</b>. <b>Current Selection Export</b> does just <b>' +
      xmlEsc(open ? open.name : 'the open clip') + '</b>. ' +
      '<b>Video with mouth overlay</b> takes the switch like everything else now, but ' +
      'it renders about as long as the clips run — so a batch of it is a job to leave ' +
      'running rather than wait on.' + longNote;
  }

  // Relabel every card so the button says what it is about to do, and show that
  // card's own toggle.
  buildScopeToggles();
  Object.keys(EXPORT_CARDS).forEach(key => {
    const spec = EXPORT_CARDS[key];
    const b = $(spec.btn);
    if (!b) return;
    b.textContent = isBatch(key) ? spec.many.replace('#', n) : spec.one;
    const row = b.parentNode.querySelector('.scoperow[data-card="' + key + '"]');
    if (row) {
      row.hidden = !many;
      row.querySelectorAll('.scopebtn').forEach(sb => {
        const on = cardScope[key] === sb.dataset.scope;
        sb.classList.toggle('on', on);
        sb.setAttribute('aria-checked', on);
      });
    }
  });
  const ovNote = $('ovBatchNote');
  if (ovNote) {
    ovNote.hidden = !many;
    const secs = queue.clips.reduce((t, c) => t + (c.duration || 0), 0);
    ovNote.textContent = isBatch('overlay')
      ? 'This renders about as long as the clips run — roughly ' +
        fmtTime(Math.round(secs)) + ' of work for all ' + n +
        '. Leave it to it, or switch this box to the open clip.'
      : 'This renders about as long as the clip runs, so it is the export that ' +
        'wants watching rather than queueing.';
  }
  // These two follow the Final Cut card's OWN toggle, not the tab's — the card
  // is the thing making the promise, so it has to be the thing that decides.
  const fcpNote = $('fcpBatchNote');
  if (fcpNote) fcpNote.hidden = !isBatch('fcp');
  // A moved STILL is rendered into the project exactly; a moved video cannot
  // be, so that one case says so rather than quietly arriving in the wrong
  // place.
  const fcpPose = $('fcpPoseNote');
  if (fcpPose) {
    fcpPose.hidden = !(plateOn('fcpPlate') && puppet.kind === 'video' &&
                       (puppetMoved() || mirror.plate));
  }
  const cw = $('fcpCompoundLabel');
  if (cw) cw.textContent = isBatch('fcp') ? 'Wrap each clip in a Compound Clip'
                                          : 'Wrap the mouths in a Compound Clip';
  // Crossing from one clip to a queue makes the batch buttons live even before
  // this clip has been analysed, so the enable pass has to run again here.
  if ($('expChart')) setExportsEnabled(state.frames.length > 0);
  syncSceneCard();
}

/** The scene card: there when there is a conversation to make one of, and
    saying what it is about to produce. */
function syncSceneCard() {
  const card = $('expScene');
  if (!card) return;
  const n = queue.clips.length;
  card.hidden = n < 2;
  if (card.hidden) return;
  const cast = queue.clips.filter(c => c.cast && castEntry(c.cast));
  const names = [...new Set(cast.map(c => castLabel(c.cast)))];
  const line = $('sceneLine');
  if (line) {
    line.textContent = names.length
      ? n + ' lines, end to end · ' + names.join(', ')
      : n + ' lines, end to end. Nobody is cast yet — the queue above will deal ' +
        'characters round them.';
  }
  const frames = convEstimateFrames();
  const est = $('estScene');
  if (est) est.textContent = frames + ' frames · ' + fmtTime(frames / state.fps);
  const go = !batchRunning;
  if ($('expSceneApng')) $('expSceneApng').disabled = !go;
  if ($('expSceneGif')) $('expSceneGif').disabled = !go;
}

function batchSay(msg) {
  const el = $('batchStatus');
  if (el) el.textContent = msg;
}

/** Every export button comes through here. The card says which format; the
    scope bar says which clips. Nothing else decides. */
function runExport(key) {
  if (batchRunning) return;
  if (isBatch(key)) return exportQueue([key]);
  return BATCH_RUNNERS[key].run();
}

async function exportQueue(picks) {
  if (batchRunning || queue.clips.length < 2 || !picks || !picks.length) return;
  batchRunning = true; batchAbort = false;
  fcpSizeLock = picks.includes('fcp') ? fcpFrameSize() : null;
  $('batchStop').hidden = false;
  updateBatchUI();
  showTab('export');

  const clips = queue.clips.slice();
  let done = 0, skipped = [];
  const combined = { size: null, entries: [], missed: [] };
  // ONE zip for the run, everything in it side by side.
  //
  // This used to be one download per clip. It works in Chrome, which is why it
  // shipped, and it does not work anywhere else: a page may start one download
  // off a click, and Safari drops the rest silently while Chrome and Edge put
  // up a "download multiple files?" prompt that has to be answered. Reported as
  // "the batch export is just exporting the first clip", which is exactly what
  // a blocked second download looks like — no error, no warning, one file.
  //
  // There is no way to ask a browser nicely for this, so the fix is to stop
  // needing it: one download, one unzip, one folder.
  const runFiles = [];
  let runBytes = 0;
  let tooBig = false;
  const taken = new Set();
  /* Everything in ONE folder.

     It used to be a folder per clip, which for the formats that make a single
     file apiece meant unzipping a folder to find a folder to find one movie.
     Flat instead — but flat only works if the names cannot collide, and some
     formats make a whole set per clip (a frame sequence is hundreds of PNGs
     named mouth_0001.png, plus a timing.csv, and both repeat for every clip).
     So each file is named for its clip unless it already is, and anything that
     still clashes gets a number rather than quietly overwriting. */
  const addToRun = (stem, files) => {
    files.forEach(f => {
      let name = String(f.name).split('/').pop();     // no folders inside either
      if (stem && name.indexOf(stem) !== 0) name = stem + '-' + name;
      if (taken.has(name)) {
        const dot = name.lastIndexOf('.');
        const head = dot > 0 ? name.slice(0, dot) : name;
        const tail = dot > 0 ? name.slice(dot) : '';
        let n = 2;
        while (taken.has(head + '-' + n + tail)) n++;
        name = head + '-' + n + tail;
      }
      taken.add(name);
      runBytes += (f.data && f.data.length) || 0;
      runFiles.push({ name, data: f.data });
    });
    if (runBytes > BATCH_MAX_BYTES) tooBig = true;
  };
  // Final Cut is the one format whose batch output is a SINGLE document: every
  // clip on one timeline. Shipping a project per clip beside it put every mouth
  // PNG in the zip twice — once under the clip's own folder, once under the
  // combined project's media folder — for a file most people would never open.
  // A batch is the combined project; one clip's own project is what Current
  // Selection Export is for. Each button now does one thing.
  const combinedOnly = picks.length === 1 && picks[0] === 'fcp';

  try {
    for (let i = 0; i < clips.length; i++) {
      if (batchAbort || tooBig) break;
      const c = clips[i];
      batchSay('Clip ' + (i + 1) + ' of ' + clips.length + ' · ' + c.name + ' · opening');
      await openClip(c.id, { force: true });
      // Same reason as the scene walk: without this the first clip of a batch
      // can be composed before its puppet has decoded.
      await awaitPlate();
      if (c.error || !state.frames.length) {
        skipped.push(c.name + (c.error ? ' (' + c.error + ')' : ''));
        continue;
      }
      const sink = [];
      // Folders only earn their place when there is more than one format.
      sink.prefix = picks.length > 1;
      for (const key of picks) {
        if (batchAbort) break;
        batchSay('Clip ' + (i + 1) + ' of ' + clips.length + ' · ' + c.name +
                 ' · ' + BATCH_RUNNERS[key].label);
        await BATCH_RUNNERS[key].run(sink);
        await new Promise(r => setTimeout(r, 0));
      }
      if (batchAbort) break;
      if (!sink.length) { skipped.push(c.name + ' (nothing produced)'); continue; }
      // Take the record for the combined project out of what was just made,
      // rather than rendering the same nine pictures a second time.
      if (picks.includes('fcp')) collectForCombined(combined, c, sink, i);
      if (!combinedOnly) addToRun(safeName(c.name), sink);
      done++;
      await new Promise(r => setTimeout(r, 0));
    }
  } catch (e) {
    console.error(e);
    batchSay('Stopped: ' + (e.message || e));
    toast('Batch export stopped: ' + (e.message || e), 6000);
  }
  // The whole queue on a single timeline. It sits at the root of the zip with
  // everything else.
  const wantCombined = combined.entries.length >= (combinedOnly ? 1 : 2);
  if (!batchAbort && !tooBig && wantCombined) {
    try {
      batchSay('Writing the combined Final Cut project…');
      addToRun('', combinedFiles(combined));
    } catch (e) {
      console.error(e);
      toast('The combined Final Cut project failed: ' + (e.message || e), 5000);
    }
  }

  if (tooBig) {
    batchSay('Too big — ' + fmtBytes(runBytes) + ' before it finished.');
    toast('That run came to more than ' + fmtBytes(BATCH_MAX_BYTES) +
          ', which is more than one download can carry. Export fewer clips at a ' +
          'time, or drop the output size.', 9000);
  } else if (runFiles.length) {
    batchSay('Writing the zip — ' + fmtBytes(runBytes) + '…');
    await paintNow();
    await deliver(runZipName(picks, clips), makeZip(runFiles));
  }

  batchRunning = false;
  fcpSizeLock = null;
  $('batchStop').hidden = true;
  setBusy(false);
  updateBatchUI();
  const tail = skipped.length ? ' · skipped ' + skipped.join(', ') : '';
  if (!tooBig) {
    batchSay(batchAbort ? 'Stopped after ' + done + ' of ' + clips.length + '.' + tail
                        : 'Done — ' + done + ' of ' + clips.length + ' exported.' + tail);
    toast(batchAbort ? 'Batch stopped after ' + done + ' clips — the zip holds what was finished.'
                     : 'Batch done — ' + done + ' clip' + (done === 1 ? '' : 's') +
                       ' in one zip, a folder each.', 5000);
  }
}

/** What the run's single zip is called. Named after the source when every clip
    came out of the same file, which is what splitting a conversation gives. */
function runZipName(picks, clips) {
  // The same tag the single-clip exports carry, so a batch zip and a one-off
  // of the same format sort together and read the same way.
  const slug = picks.length === 1
    ? (EXPORT_TAG[picks[0]] || BATCH_RUNNERS[picks[0]].slug || picks[0])
    : 'EXPORTS';
  const files = new Set(clips.map(c => c.file));
  const stem = files.size === 1
    ? safeName((clips[0].file.name || 'lip-sync').replace(/\.[^.]+$/, '').replace(/-\d+$/, ''))
    : 'lip-sync';
  return stem + '-' + slug + '.zip';
}

/** Pull this clip's nine pictures back out of the zip it is about to become,
    and note where its clips sit, so the combined timeline can be assembled
    without re-rendering anything. */
function collectForCombined(combined, clip, sink, index) {
  const { w, h } = fcpFrameSize();
  if (!combined.size) combined.size = { w, h };
  if (combined.size.w !== w || combined.size.h !== h) {
    // One timeline cannot be two sizes. The size is pinned for the run, so
    // this should be unreachable; it stays because a clip silently missing
    // from the timeline is worse than a clip that says why.
    combined.missed.push(clip.name + ' (' + w + '×' + h + ')');
    return;
  }
  const dir = String(index + 1).padStart(2, '0') + '-' + safeName(clip.name);
  const pngs = sink.filter(f => /(^|\/)mouths\/mouth-[XABCDEFGH]\.png$/.test(f.name))
                   .map(f => ({ name: dir + '/' + f.name.split('/').pop(), data: f.data }));
  if (!pngs.length) return;
  // The puppet comes through the same way the pictures do — out of the zip this
  // clip was about to become. Each clip keeps its own, so a two-hander with a
  // different puppet per speaker arrives with both.
  const pupFile = sink.find(f => /(^|\/)puppet\//.test(f.name));
  const pup = pupFile && fcpPuppetInfo();
  // And the voice, the same way. On the combined timeline each clip's own
  // track sits at that clip's offset, which is what makes a split conversation
  // arrive with every line already under its own mouths.
  const audFile = sink.find(f => /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(f.name));
  const aud = audFile && fcpAudioInfo({ name: audFile.name.split('/').pop() });
  combined.entries.push({
    name: clip.name, dir, pngs,
    frames: state.frames.length,
    segs: fcpSegments(w, h),
    states: fcpStates(w, h),
    puppet: pup ? { ...pup, rel: dir + '/' + pupFile.name.split('/').pop(),
                    data: pupFile.data, flip: mirror.plate } : null,
    audio: aud ? { ...aud, rel: dir + '/' + audFile.name.split('/').pop(),
                   data: audFile.data } : null
  });
}

function combinedFiles(combined) {
  const { w, h } = combined.size;
  const files = [];
  combined.entries.forEach(e => {
    e.pngs.forEach(f => files.push(f));
    if (e.puppet) files.push({ name: e.puppet.rel, data: e.puppet.data });
    if (e.audio) files.push({ name: e.audio.rel, data: e.audio.data });
  });
  const enc = new TextEncoder();
  files.push({ name: 'all-clips.fcpxml', data: enc.encode(fcpxmlMulti(combined.entries, w, h)) });
  files.push({ name: 'README.txt', data: enc.encode(fcpMultiReadme(combined.entries, w, h)) });
  const miss = combined.missed.length
    ? ' (' + combined.missed.join(', ') + ' left out — different frame size)' : '';
  toast('Combined Final Cut project written — ' + combined.entries.length + ' clips.' + miss, 5000);
  return files;
}

const safeName = n => (n || 'clip').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

/* --- what an export is called ------------------------------------------------

   Eight formats, one take, and until now several of them came down with names
   that differed by a word nobody reads: "-mouth" was the GIF AND the animated
   PNG, "-key" was the chroma MP4, "-fcp" the project. Eight files of one clip
   in a Downloads folder is exactly the moment you cannot tell them apart, and
   Final Cut shows the file name on the clip, so the wrong one goes on the
   timeline and looks right until it does not.

   So the tag is loud and it is last: SPEECH-APNG.png, SPEECH-CHROMA.mp4. Upper
   case because it is a label rather than part of the name, and at the end
   because that is where the eye goes when the beginnings are all the same. */
const EXPORT_TAG = {
  chart: 'CHART', fcp: 'FCPXML', gif: 'GIF', apng: 'APNG',
  sprite: 'SPRITE', seq: 'FRAMES', mp4: 'CHROMA', overlay: 'OVERLAY'
};

/** The stem an export's files are built from: the clip's name with whatever
    extension it arrived with taken off, and the format's tag on the end. */
function exportName(kind) {
  const stem = (state.name || 'mouth').replace(/\.[^.]+$/, '');
  return safeName(stem) + '-' + (EXPORT_TAG[kind] || kind.toUpperCase());
}

/* ---- chroma-key video ---------------------------------------------------

   WebCodecs encodes; MP4.build() containerises. H.264 is tried first and VP9
   is the fallback, since a browser without a licensed H.264 encoder still has
   VP9 — both are legal in an MP4.
--------------------------------------------------------------------------- */

const KEY_PRESETS = [
  ['#00B140', 'Chroma green'],
  ['#00FF00', 'Pure green'],
  ['#0047BB', 'Chroma blue'],
  ['#FF00FF', 'Magenta']
];

const even2 = n => Math.max(2, Math.round(n / 2) * 2);
const videoBitrate = (w, h, fps) => clamp(Math.round(w * h * fps * 0.5), 2e6, 40e6);

const codecCache = new Map();
async function pickVideoCodec(size, fps) {
  const key = size + 'x' + fps;
  if (codecCache.has(key)) return codecCache.get(key);
  const found = await probeVideoCodec(size, fps);
  codecCache.set(key, found);
  return found;
}

async function probeVideoCodec(size, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  const bitrate = videoBitrate(size, size, fps);
  const ladder = [
    ['avc1.640034', 'avc1'], ['avc1.4d0034', 'avc1'], ['avc1.640028', 'avc1'],
    ['avc1.4d0028', 'avc1'], ['avc1.42002a', 'avc1'], ['avc1.42001f', 'avc1'],
    ['vp09.00.10.08', 'vp09']
  ];
  for (const [codec, family] of ladder) {
    const cfg = { codec, width: size, height: size, bitrate, framerate: fps,
                  latencyMode: 'realtime' };   // no B-frames, so decode order == display order
    if (family === 'avc1') cfg.avc = { format: 'avc' };     // length-prefixed, as MP4 wants
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s && s.supported) return { cfg, family };
    } catch (e) { /* try the next rung */ }
  }
  return null;
}

/* Prefer the source's own AAC track: it needs no encoder, loses no quality,
   and carries its own edit list. It is extracted once when the file is loaded —
   re-reading a multi-hundred-megabyte movie on every estimate refresh starves
   everything else in the tab, the video decoder included. */
/** How long a copied track runs, in seconds. */
function copiedTrackSeconds(track) {
  if (!track || !track.samples || !track.samples.length) return 0;
  const sr = track.sampleRate || 44100;
  return track.samples.reduce((n, s) => n + (s.duration || 1024), 0) / sr;
}

/** True when the open clip uses the whole file, handles untouched. */
function clipIsWholeFile(c) {
  if (!c) return true;                       // a file opened on its own
  const dur = c.srcDuration || 0;
  const inAt = c.in || 0;
  const outAt = c.out == null ? dur : c.out;
  return inAt <= 0.02 && (!dur || outAt >= dur - 0.02);
}

/** The container's own sound frames, cut to the part of the file this clip
    actually uses.

    Copying the track out of the source is exact and costs nothing, and it is
    the right thing to do — for a clip that IS the file. For a trimmed or split
    one it wrote the WHOLE recording against a few seconds of picture, and a
    movie lasts as long as its longest track: the picture stopped and the
    player showed black for the rest of it. Reported as "it seems to have done
    the first clip and then left the rest blank", which is exactly what that
    looks like from outside, and on a split line the voice was the wrong line's
    as well.

    Sound frames hold 1024 samples, so the cut lands within about 23ms of the
    handle — inside one frame at 24fps, and it keeps the copy. Landing it to
    the sample would mean re-encoding: a generation of quality lost, and a
    browser that can encode AAC at all. */
function trimCopiedAudio(track, inS, outS) {
  if (!track || !track.samples || !track.samples.length) return null;
  const sr = track.sampleRate || 44100;
  const total = copiedTrackSeconds(track);
  const a = Math.max(0, inS || 0);
  const b = Math.min(outS == null ? total : outS, total);
  if (a <= 0.02 && b >= total - 0.02) return track;      // it is the whole file
  if (!(b > a)) return null;
  const keep = [];
  let at = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i];
    const len = (s.duration || 1024) / sr;
    const mid = at + len / 2;
    if (mid >= a && mid < b) keep.push(s);
    at += len;
  }
  if (!keep.length) return null;
  // editStart skips the encoder's priming frames at the head of the ORIGINAL
  // track. A cut taken from the middle starts at its own beginning.
  return { ...track, samples: keep, editStart: 0, source: 'trimmed' };
}

async function audioTrackFor(onProgress) {
  if (state.srcAudio) {
    const c = activeClip();
    const cut = c ? trimCopiedAudio(state.srcAudio, c.in || 0, c.out == null ? null : c.out)
                  : state.srcAudio;
    if (cut) return cut;
  }
  const enc = await encodeAAC(state.buffer, onProgress);
  return enc ? { ...enc, source: 'encoded' } : null;
}

/** What the export will do with audio. Cheap: nothing here touches the file. */
function audioPlan() {
  if (!state.buffer) return { kind: 'none', label: 'no audio' };
  if (state.srcAudio) {
    return clipIsWholeFile(activeClip())
      ? { kind: 'copy', label: 'audio copied from the source' }
      : { kind: 'cut', label: 'audio copied from the source, cut to this clip' };
  }
  if (!aacEncoderAvailable) {
    return { kind: 'none', label: 'this browser cannot encode AAC — the file will be silent' };
  }
  return { kind: 'encode', label: 'audio re-encoded to AAC' };
}

/* Probed once at start-up so the estimate line stays synchronous. */
let aacEncoderAvailable = false;
(async () => {
  if (typeof AudioEncoder === 'undefined') return;
  try {
    const ok = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1, bitrate: 128000
    });
    aacEncoderAvailable = !!(ok && ok.supported);
  } catch (e) { /* leave it false */ }
})();

async function encodeAAC(buffer, onProgress) {
  if (typeof AudioEncoder === 'undefined' || !buffer) return null;
  const sampleRate = buffer.sampleRate;
  const channels = Math.min(2, buffer.numberOfChannels);
  const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128000 };
  try {
    const s = await AudioEncoder.isConfigSupported(cfg);
    if (!s || !s.supported) return null;
  } catch (e) { return null; }

  const samples = [];
  let description = null, failed = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
        description = new Uint8Array(meta.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const dur = chunk.duration ? Math.round(chunk.duration * sampleRate / 1e6) : 1024;
      samples.push({ data, duration: dur });
    },
    error: e => { failed = e; }
  });
  enc.configure(cfg);

  const BLOCK = 8192;
  for (let off = 0; off < buffer.length && !failed; off += BLOCK) {
    const n = Math.min(BLOCK, buffer.length - off);
    const planar = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) buffer.copyFromChannel(planar.subarray(c * n, c * n + n), c, off);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round(off / sampleRate * 1e6), data: planar
    });
    enc.encode(ad);
    ad.close();
    if ((off / BLOCK) % 16 === 0) {
      onProgress && onProgress(off / buffer.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  try { await enc.flush(); } catch (e) { failed = e; }
  try { enc.close(); } catch (e) {}
  if (failed || !description || !samples.length) {
    console.warn('AAC encoding unavailable:', failed);
    return null;
  }
  // AAC-LC encoders prime with 1024 samples before the first real one. The
  // remux test against ffmpeg confirms trimming exactly that many lines the
  // audio up sample-for-sample.
  return { sampleRate, channels, description, samples, bitrate: 128000, editStart: 1024 };
}

async function exportVideo(sink) {
  if (!state.frames.length) return;
  const size = parseInt($('outSize').value, 10);
  const fps = state.fps;
  const key = $('keyColor').value;
  const wantAudio = $('keyAudio').checked;
  // With the puppet in it the frame stops being a square of key colour with a
  // mouth on it and becomes the whole picture, at the puppet's own proportions.
  // A cut-out puppet's transparency has nowhere to go in an MP4, so it fills
  // with the key colour — which is the right answer rather than a compromise:
  // key it out and the cut-out is cut out again on the far side.
  const withPlate = plateOn('mp4Plate');
  const pf = withPlate ? plateCellSize(size * 2) : null;
  const W = pf ? even(pf.w) : size, H = pf ? even(pf.h) : size;

  const wasPlaying = playing;
  if (withPlate && playing) player.pause();
  const resumeAt = player.currentTime;

  setBusy(true, 0);
  try {
    const pick = await pickVideoCodec(Math.max(W, H), fps);
    if (!pick) {
      toast('This browser has no video encoder available. The frame-sequence export is the way out.', 5200);
      setBusy(false);
      return;
    }

    const TS = 90000, frameDur = Math.round(TS / fps);
    const samples = [];
    let description = null, encodeError = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          description = new Uint8Array(meta.decoderConfig.description);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // Chunks arrive in decode order; the timestamp is the display time. If
        // the encoder ever reorders, this offset is what puts it back.
        const dts = samples.length * frameDur;
        const pts = Math.round(chunk.timestamp * TS / 1e6);
        samples.push({ data, duration: frameDur, isKey: chunk.type === 'key', cts: pts - dts });
      },
      error: e => { encodeError = e; }
    });
    enc.configure({ ...pick.cfg, width: W, height: H });

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { alpha: false });
    const gop = Math.max(1, Math.round(fps * 2));

    for (let i = 0; i < state.frames.length; i++) {
      if (encodeError) throw encodeError;
      if (withPlate) await composePlateFrame(ctx, W, H, i / fps, key, fxOpt('mp4Fx'));
      else paintMouth(ctx, size, size, state.frames[i].v, state.style, key);
      const vf = new VideoFrame(c, {
        timestamp: Math.round(i * 1e6 / fps),
        duration: Math.round(1e6 / fps)
      });
      enc.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      if (enc.encodeQueueSize > 12 || (i & 7) === 7) {
        setBusy(true, (i / state.frames.length) * 0.7);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    await enc.flush();
    enc.close();
    if (encodeError) throw encodeError;
    if (!samples.length) throw new Error('the encoder produced no frames');
    if (pick.family === 'avc1' && !description) throw new Error('the encoder gave no H.264 configuration');

    setBusy(true, 0.78);
    let audio = null;
    if (wantAudio) {
      audio = await audioTrackFor(p => setBusy(true, 0.78 + p * 0.12));
      if (!audio) toast('No AAC encoder here, so the MP4 is video only — drop your original audio at 00:00.', 5200);
    }

    setBusy(true, 0.94);
    const bytes = MP4.build({
      codec: pick.family, width: W, height: H, timescale: TS, description, samples
    }, audio);

    if (Array.isArray(sink)) sink.push({ name: (sink.prefix ? 'chroma/' : '') +
      exportName('mp4') + '.mp4', data: bytes });
    else await deliver(exportName('mp4') + '.mp4', bytes, 'video/mp4');
    toast('Exported ' + state.frames.length + ' frames as ' +
          (pick.family === 'avc1' ? 'H.264' : 'VP9') +
          (withPlate ? ' with the puppet' : '') +
          (audio ? ' with audio' : ' (video only)') + ' · ' + fmtBytes(bytes.length) + '.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Video export failed: ' + (e.message || e), 5200);
  }
  if (withPlate) {
    // Stepping the plate moved the playhead; put it back where it was found.
    try { player.currentTime = resumeAt; if (wasPlaying) await player.play(); } catch (e) {}
  }
  setBusy(false);
}

/* ---- burn the mouth onto the source video --------------------------------

   Stepping the video with seeks rather than recording it in real time: the
   frame at t is exactly the frame written, so the mouth never drifts against
   the picture. Slower than playback, and worth it.
--------------------------------------------------------------------------- */

function seekExact(t) {
  return new Promise(res => {
    let done = false;
    const finish = () => { if (done) return; done = true; player.removeEventListener('seeked', finish); res(); };
    player.addEventListener('seeked', finish);
    try { player.currentTime = t; } catch (e) { finish(); return; }
    setTimeout(finish, 500);            // some sources never fire for a no-op seek
  });
}

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

/** The plate, on a canvas, at clip time `t`. Every export that shows the
    picture comes through here, so none of them can disagree about which frame
    of it belongs where.

    For the clip's own footage `t` has to be translated first: it is clip time,
    and the element is playing the source file. Trimmed, or with a bit dropped,
    those are different numbers — seeking with the clip time grabs footage from
    the head of the file while the soundtrack comes from the trim, and the whole
    export is out by the trim amount. */
async function drawPlateFrame(ctx, W, H, t) {
  // The seek has to happen before the transform is set, and the transform has
  // to come off afterwards whatever happened, so the mirror wraps the draw
  // rather than the whole function.
  // The mirror used to be handled here on its own. It is one case of the
  // puppet's placement now, so there is a single transform rather than two
  // that have to be kept in step.
  const put = (el) => {
    const pz = plateSize() || { w: W, h: H };
    const w = puppetPose.size * W;
    const h = w * (pz.h / Math.max(1, pz.w));
    ctx.save();
    ctx.translate(puppetPose.x * W, puppetPose.y * H);
    ctx.rotate(puppetPose.rot * Math.PI / 180);
    if (mirror.plate) ctx.scale(-1, 1);
    ctx.drawImage(el, -w / 2, -h / 2, w, h);
    ctx.restore();
  };
  if (puppet.kind === 'image') { put(puppet.img); return; }
  if (puppet.kind === 'video') {
    await seekPlate(puppetTimeAt(t));
    if (plateVideo.videoWidth) put(plateVideo);
    return;
  }
  await seekExact(clipToSrc(activeClip(), t));
  put(player);
}

async function exportOverlayVideo(sink) {
  const pz = frameHasContent() ? frameSize() : null;
  if (!pz || !state.frames.length) return;
  const fps = parseInt($('ovFps').value, 10);
  const long = parseInt($('ovSize').value, 10);
  const scale = Math.min(1, long / Math.max(pz.w, pz.h));
  const W = even(pz.w * scale), H = even(pz.h * scale);
  const duration = state.buffer.duration;
  const total = Math.max(1, Math.round(duration * fps));

  const wasPlaying = playing;
  if (playing) player.pause();
  const resumeAt = player.currentTime;

  setBusy(true, 0);
  try {
    const pick = await pickVideoCodec(Math.max(W, H), fps);
    if (!pick) { toast('This browser has no video encoder available.', 5000); setBusy(false); return; }
    const cfg = { ...pick.cfg, width: W, height: H, bitrate: videoBitrate(W, H, fps), framerate: fps };
    const TS = 90000, frameDur = Math.round(TS / fps);
    const samples = [];
    let description = null, encodeError = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!description && meta && meta.decoderConfig && meta.decoderConfig.description) {
          description = new Uint8Array(meta.decoderConfig.description);
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const dts = samples.length * frameDur;
        const pts = Math.round(chunk.timestamp * TS / 1e6);
        samples.push({ data, duration: frameDur, isKey: chunk.type === 'key', cts: pts - dts });
      },
      error: e => { encodeError = e; }
    });
    enc.configure(cfg);

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { alpha: false });
    const gop = Math.max(1, Math.round(fps * 2));
    // Read once, before the loop: a box toggled mid-render would change the
    // picture halfway through the file.
    const fxOpts = {
      noExtras: !($('ovLayers') || {}).checked,
      noFx: !($('ovFx') || {}).checked,
    };
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError;
      const t = Math.min(duration - 0.001, i / fps);
      /* The WHOLE picture, through the one compositor.

         This used to draw the plate and then the mouth on top of it, by hand —
         which meant it was the only export that did not go through
         `compositeLayers`, and so the only one that lost everything that lives
         there: the other layers, the line boil, balloons, text, the drop
         shadows. Reported as "I had line boil turned on but it did not carry
         over to the exported video, nor did the background" — both of those are
         layers-and-boil, and both were simply never asked for.

         `composePlateFrame` is what the scene export and the preview use. It
         paints the plate (a puppet, a puppet video, or the clip's own footage)
         into a scratch canvas and hands it to the compositor as one layer among
         the rest, so what comes out here is what is on the stage. The ground is
         filled black because a video cannot hold transparency. */
      await composePlateFrame(ctx, W, H, t, '#000000', fxOpts);

      const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
      setBusy(true, (i / total) * 0.82);
    }
    await enc.flush();
    enc.close();
    if (encodeError) throw encodeError;
    if (pick.family === 'avc1' && !description) throw new Error('the encoder gave no H.264 configuration');

    setBusy(true, 0.85);
    const audio = await audioTrackFor(p => setBusy(true, 0.85 + p * 0.1));
    if (!audio) toast('This browser could neither copy nor encode the audio, so the overlay video is silent.', 6000);

    setBusy(true, 0.96);
    const bytes = MP4.build({
      codec: pick.family, width: W, height: H, timescale: TS, description, samples
    }, audio);
    if (Array.isArray(sink)) {
      sink.push({ name: (sink.prefix ? 'overlay/' : '') + exportName('overlay') + '.mp4',
                  data: bytes });
    } else {
      await deliver(exportName('overlay') + '.mp4', bytes, 'video/mp4');
    }
    toast('Overlay video exported · ' + W + '×' + H + ' at ' + fps + ' fps · ' +
          (audio ? (audio.source === 'copied' ? 'audio copied'
                    : audio.source === 'trimmed' ? 'audio copied and cut to the clip'
                    : 'audio re-encoded') : 'no audio') +
          ' · ' + fmtBytes(bytes.length) + '.');
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'declined' ? 'Save cancelled.' : 'Overlay export failed: ' + (e.message || e), 5200);
  }
  setBusy(false);
  try { player.currentTime = resumeAt; } catch (e) {}
  if (wasPlaying) player.play().catch(() => {});
}

/* ---- size estimates ---- */

let estBytes = 0;
async function updateEstimates() {
  const size = parseInt($('outSize').value, 10);
  const n = state.frames.length;
  if (!n) {
    $('estChart').textContent = $('estSeq').textContent = $('estSprite').textContent =
      $('estFcp').textContent = $('estGif').textContent = $('estApng').textContent = '—';
    return;
  }
  const probe = await pngBytes(size, 'D');
  estBytes = probe.length;
  const shapes = VIS.length;
  $('estChart').textContent = shapes + ' PNG + timing · ≈ ' + fmtBytes(estBytes * shapes + n * 40);
  $('estSeq').textContent = n.toLocaleString() + ' PNG · ≈ ' + fmtBytes(estBytes * n * 0.92);
  if (plateOn('spritePlate')) {
    // Nine cells for a still puppet that is not being moved, one per frame for
    // anything that is.
    const flip = everyFrameDiffers();
    const cells = flip ? n : usedVisemes().length;
    const cf = plateCellSize(1024);
    const cols = Math.max(1, Math.min(cells, Math.ceil(Math.sqrt(cells * cf.h / cf.w))));
    const rows = Math.ceil(cells / cols);
    const fit = Math.min(1, SPRITE_SHEET_MAX / (cols * cf.w), SPRITE_SHEET_MAX / (rows * cf.h));
    const cw = Math.max(2, Math.floor(cf.w * fit)), ch = Math.max(2, Math.floor(cf.h * fit));
    $('estSprite').textContent = '1 PNG (' + cols + '×' + rows + ' of ' + cw + '×' + ch +
      ') · with the puppet · ≈ ' + fmtBytes(cells * cw * ch * (plateHasAlpha() ? 0.16 : 0.55));
  } else {
    $('estSprite').textContent = '1 PNG (' + Math.min(shapes, 5) + '×' + Math.ceil(shapes / 5) + ') · ≈ ' + fmtBytes(estBytes * shapes * 0.8);
  }
  // One frame per frame of the animation now, not one per run — the count on
  // the card has to say so, because it is the thing that decides the size.
  const gifSegs = Math.max(1, Math.round(n / state.fps * gifRate().fps));
  const runCount = runs().length;
  const movingPlate = everyFrameDiffers();
  // A GIF of a whole picture is a different animal: every frame stores the
  // whole thing, and the long edge is capped whatever output size is chosen.
  const gf = plateOn('gifPlate') ? plateCellSize(Math.min(GIF_PLATE_MAX, size)) : null;
  $('estGif').textContent = gf
    ? gifSegs.toLocaleString() + ' GIF frames at ' + gf.w + '×' + gf.h + ' · with the puppet · ≈ ' +
      fmtBytes((movingPlate ? gifSegs : runCount) * gf.w * gf.h *
               (plateHasAlpha() ? 0.10 : 0.34) + gifSegs * 24 + 1200)
    : gifSegs.toLocaleString() + ' GIF frames at ' + size + '×' + size +
      ' · ≈ ' + fmtBytes(gifEstimate(size));
  // With the puppet in it the frames are the puppet's size and every one is
  // its own picture, so neither the dimensions nor the weight are the
  // mouth-only ones.
  const pf = plateOn('apngPlate') ? plateFrameSize() : null;
  // Bytes per pixel per frame, measured: a cut-out puppet is mostly nothing and
  // deflates to about a twelfth of a byte a pixel, while an opaque photograph
  // is real detail everywhere and runs nearer half. One number for both would
  // be six times wrong in one direction or the other.
  const perPx = plateHasAlpha() ? 0.12 : 0.45;
  // An APNG runs at the take's own rate, and a held shape costs a thirty-byte
  // hold frame rather than a picture — so the weight goes with the number of
  // DISTINCT pictures, which for a still puppet is the run count and for a
  // moving one is every frame.
  const apngReal = pf ? (movingPlate ? n : runCount) : runCount;
  $('estApng').textContent = pf
    ? n.toLocaleString() + ' frames at ' + pf.w + '×' + pf.h + ' · with the puppet · ≈ ' +
      fmtBytes(apngReal * pf.w * pf.h * perPx + n * 40 + 200)
    : n.toLocaleString() + ' frames at ' + size + '×' + size +
      ' · ≈ ' + fmtBytes(apngEstimate(size, estBytes) + n * 40);
  const sf = plateOn('seqPlate') ? plateFrameSize() : null;
  if (sf) {
    $('estSeq').textContent = n.toLocaleString() + ' PNG at ' + sf.w + '×' + sf.h +
      ' · with the puppet · ≈ ' + fmtBytes(n * sf.w * sf.h * (plateHasAlpha() ? 0.16 : 0.55));
  }
  // The Final Cut option can match the video, but only once there is one.
  const fcpVid = $('fcpSizeVideo');
  const hadVideo = !fcpVid.hidden;
  const pz = frameHasContent() ? frameSize() : null;
  fcpVid.hidden = fcpVid.disabled = !pz;
  if (pz) {
    fcpVid.textContent = 'Match the picture (' + pz.w + ' × ' + pz.h + ')';
    if (!hadVideo) $('fcpSize').value = 'video';
  } else if ($('fcpSize').value === 'video') {
    $('fcpSize').value = '1920x1080';
  }
  const fcp = fcpFrameSize();
  const fcpProbe = await fcpFramePng(fcp.w, fcp.h, 'D');
  const fSegs = fcpSegments(fcp.w, fcp.h).length;
  const fPngs = shapes;
  const fPup = plateOn('fcpPlate') ? plateFile() : null;
  $('estFcp').textContent = fSegs.toLocaleString() + ' clips · ' + fPngs + ' PNG at ' +
    fcp.w + '×' + fcp.h + (fPup ? ' + the puppet' : '') + ' · ≈ ' +
    fmtBytes(fcpProbe.length * fPngs + 400 * fSegs + (fPup ? fPup.size || 0 : 0));

  const secs = state.buffer ? state.buffer.duration : n / state.fps;
  const kf = plateOn('mp4Plate') ? plateCellSize(size * 2) : null;
  const kw = kf ? even(kf.w) : size, kh = kf ? even(kf.h) : size;
  const pick = await pickVideoCodec(Math.max(kw, kh), state.fps);
  const label = !pick ? 'no encoder in this browser'
    : pick.family === 'avc1' ? 'H.264' : 'VP9';
  // A picture with detail all over it costs more per second than a mouth on a
  // flat key, which compresses to almost nothing.
  $('estMp4').textContent = fmtTime(secs) + ' · ' + label +
    (kf ? ' · with the puppet at ' + kw + '×' + kh : '') + ' · ≈ ' +
    fmtBytes(videoBitrate(kw, kh, state.fps) / 8 * secs * (kf ? 0.8 : 0.35) +
             (($('keyAudio') || {}).checked ? 16000 * secs : 0));
  const plan = audioPlan();
  const planEl = $('audioPlan');
  if (planEl) { planEl.textContent = plan.label; planEl.classList.toggle('warn', plan.kind === 'none'); }
  if (pz) {
    const ofps = parseInt($('ovFps').value, 10);
    const olong = parseInt($('ovSize').value, 10);
    const os = Math.min(1, olong / Math.max(pz.w, pz.h));
    const ow = even2(pz.w * os), oh = even2(pz.h * os);
    $('estOverlay').textContent = ow + '×' + oh + ' · ' + Math.round(secs * ofps) +
      ' frames · about ' + fmtTime(Math.round(secs * ofps) * 0.04) + ' to render';
  }
  // A VP9 MP4 is a valid file that QuickTime will still refuse to open, so say
  // so before the export rather than after.
  const warn = $('mp4Warn');
  if (!pick) {
    warn.hidden = false;
    warn.textContent = 'This browser has no video encoder. Use the frame sequence instead.';
  } else if (pick.family !== 'avc1') {
    warn.hidden = false;
    warn.textContent = 'This browser offers no H.264 encoder, so the file will be VP9. QuickTime cannot open VP9 — Chrome, VLC and Resolve can.';
  } else {
    warn.hidden = true;
  }
}

function setExportsEnabled(on) {
  // A batch run needs the queue, not the clip that happens to be open, so the
  // buttons stay live even before this one has been analysed — the run analyses
  // each clip as it reaches it. They only go dead while a run is going.
  const ready = (on || (batchMode() && queue.clips.length > 1)) && !batchRunning;
  // The boil demo needs frames to step through, and this is the one place that
  // runs every time that changes.
  const tb = $('boilTry');
  if (tb) tb.disabled = !state.frames.length;
  $('expChart').disabled = !ready;
  $('expFcp').disabled = !ready || download.mode === 'artifact';
  $('expSprite').disabled = !ready;
  $('expGif').disabled = !ready;
  $('expApng').disabled = !ready;
  $('expMp4').disabled = !ready || !videoEncoderPresent;
  // The overlay video is the one export that is never batched, so it answers to
  // the open clip alone whatever the scope says.
  $('expOverlay').disabled = !on || !videoEncoderPresent || !hasPlate() || batchRunning;
  $('expOverlayCard').hidden = !hasPlate();
  $('expSeq').disabled = !ready || download.mode === 'artifact';
}
const videoEncoderPresent = typeof VideoEncoder !== 'undefined';

/* ------------------------------------------------------------- custom art */

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/* ---- lip sets: folders of drawings that ship with the page ----------------

   A set is nine pictures and a name, in a folder inside LIPS_DIR beside this
   HTML file. The page scans that folder when it opens and shows whatever is
   there; there is nothing for a visitor to add, upload or remove. Curating the
   art is a matter of putting folders on the server, which is the point — the
   sets are part of what you shipped, not something each viewer assembles.

   Once loaded a set is exactly the same thing as a built-in style from the
   renderer's point of view — custom.map — so the chart, the stage and every
   export follow without knowing where the art came from.

   THE ONE CAVEAT, measured rather than assumed: this needs the page to be
   served over http. Opened straight off the disk (file://) the browser refuses
   the fetch outright, and an <img> loaded that way taints the canvas, which
   would break every export. So from file:// the shelf says so instead of
   half-working.
--------------------------------------------------------------------------- */

// The one knob. Change it here to keep the art somewhere else.
const LIPS_DIR = 'lips/';

const lips = { sets: [], activeId: null, path: LIPS_DIR };
const IMG_RE = /\.(png|webp|gif|jpe?g|svg)$/i;

const servedOverHttp = () => /^https?:$/.test(location.protocol);

/* --- turning files into a set -------------------------------------------- */

/** Which shape a filename is claiming to be. A letter on its own, so
    "mouth-D.png", "D.png" and "04_D_wide.png" all land on D. */
function shapeOfName(name) {
  const base = name.replace(/\.[^.]+$/, '').toUpperCase();
  const m = base.match(/(?:^|[^A-Z])([XABCDEFGH])(?:[^A-Z]|$)/);
  return m ? m[1] : null;
}

/** Nine pictures out of however many turned up, as INDICES into the set's own
    list rather than as the pictures themselves — which is what lets the viewer
    reassign them afterwards without the folder being re-read.

    Anything the folder does not name falls back to a picture it does have, so
    a frame is never blank, and every shape filled that way is listed in
    `guessed` so the interface can say which ones were a guess. */
function autoAssign(pics) {
  const by = {}, taken = new Set();
  pics.forEach((e, i) => {
    const v = shapeOfName(e.name);
    if (v && !taken.has(v)) { by[v] = i; taken.add(v); }
  });
  const used = new Set(Object.values(by));
  const spare = pics.map((_, i) => i).filter(i => !used.has(i));
  let k = 0;
  const guessed = [];
  VIS.forEach(v => {
    if (by[v] != null) return;
    guessed.push(v);
    if (spare[k] != null) by[v] = spare[k++];
  });
  // Whatever is left over takes a stand-in, so no frame is ever empty.
  const stand = by.A != null ? by.A : by.X != null ? by.X : Object.values(by)[0];
  if (stand != null) VIS.forEach(v => { if (by[v] == null) by[v] = stand; });
  return { by, guessed };
}

/** Rebuild `map` — the thing the renderer actually reads — from the indices.
    Called on import and again after every reassignment. */
function relinkLipSet(set) {
  set.map = {};
  VIS.forEach(v => {
    const p = set.pics[set.by[v]];
    if (p) set.map[v] = p.src;
  });
  return set;
}

function asSource(img) {
  return { img, sx: 0, sy: 0, sw: img.naturalWidth || img.width, sh: img.naturalHeight || img.height };
}

/** blobs: [{name, blob}] → a set ready to draw, or null if none decoded.
    `origin` is 'shipped' for a folder that came with the page and 'session'
    for one the viewer picked; the two are treated differently in exactly one
    place, which is how long they last. */
async function buildLipSet(id, name, blobs, origin) {
  const pics = [];
  for (const b of blobs) {
    try { pics.push({ name: b.name, src: asSource(await loadImage(b.blob)) }); }
    catch (e) { console.warn('skipped', b.name, e); }
  }
  if (!pics.length) return null;
  // In name order, counting numerically — `frame2` before `frame10`. A folder
  // picker hands its files over in whatever order it likes, and that order is
  // what the fallback assigns by, so a set numbered 1–9 in chart order only
  // lands right if they are sorted first. It also stops the list in the
  // matching dialog jumping about between one import and the next.
  pics.sort((a, b2) => a.name.localeCompare(b2.name, undefined, { numeric: true, sensitivity: 'base' }));
  const { by, guessed } = autoAssign(pics);
  return relinkLipSet({ id, name, origin: origin || 'shipped', pics, by,
                        guessed, count: pics.length });
}

/** Point one shape at one picture, by hand. The viewer has just told us what
    this picture is, so it stops counting as a guess. */
function assignShape(set, v, index) {
  if (!set || !set.pics[index] || !VIS.includes(v)) return;
  set.by[v] = index;
  set.guessed = set.guessed.filter(s => s !== v);
  relinkLipSet(set);
  if (lips.activeId === set.id) useLipSet(set.id, true);
  else buildLipChips();
}

function lipSetById(id) { return lips.sets.find(s => s.id === id) || null; }

function useLipSet(id, quiet) {
  const set = lipSetById(id);
  if (!set) return;
  custom.on = true;
  custom.map = set.map;
  custom.sources = VIS.map(v => ({ label: v, ...set.map[v] })).filter(s => s.img);
  lips.activeId = id;
  document.querySelectorAll('.style-opt').forEach(el => el.classList.remove('sel'));
  buildLipChips(); buildChart(); drawStage(); updateEstimates();
  const c = activeClip();
  if (c) c.lipSetId = id;
  renderQueue();
  if (!quiet) toast('Using “' + set.name + '”.', 1800);
}

/* --- reading the folder --------------------------------------------------- */

const joinPath = (a, b) => a.replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '');

async function fetchOk(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r;
}

/** Names of things linked from a served directory listing. The stock listings
    from python -m http.server and nginx autoindex both work this way, so a
    folder of folders needs no manifest for the common case. */
function linksIn(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  doc.querySelectorAll('a[href]').forEach(a => {
    let h = a.getAttribute('href');
    if (!h || /^[a-z]+:/i.test(h) || h.startsWith('#') || h.startsWith('?') || h.startsWith('..')) return;
    h = decodeURIComponent(h.replace(/^\.\//, ''));
    if (h.startsWith('/')) {
      const b = new URL(base, location.href).pathname;
      if (!h.startsWith(b)) return;
      h = h.slice(b.length);
    }
    if (h) out.push(h);
  });
  return out;
}

async function scanOneLipFolder(url, name) {
  const files = [];
  let listed = null;
  try {
    const r = await fetchOk(url.endsWith('/') ? url : url + '/');
    const type = r.headers.get('content-type') || '';
    if (/html/i.test(type)) listed = linksIn(await r.text(), url).filter(h => IMG_RE.test(h));
  } catch (e) { /* no listing; fall back to guessing the names */ }
  const names = listed && listed.length ? listed : VIS.map(v => v + '.png');
  for (const n of names) {
    try {
      const r = await fetchOk(joinPath(url, n));
      files.push({ name: n.split('/').pop(), blob: await r.blob() });
    } catch (e) { /* a shape that is not there is not an error */ }
  }
  if (!files.length) return null;
  return buildLipSet('p_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, files, 'shipped');
}

/** Everything under LIPS_DIR: the server's own directory listing first, then a
    sets.json manifest for servers that do not offer one, and failing both, the
    folder itself is treated as a single set.

    The listing is tried FIRST on purpose. Asking for sets.json first meant a
    404 in the console on every single page load for the common setup, where
    the listing would have answered the question. A tidy console is not a
    detail: it is where the next real error has to be visible. */
async function scanLipFolder(path) {
  if (!servedOverHttp()) return 0;
  lips.sets = lips.sets.filter(x => x.origin === 'session');

  let folders = null;
  let listable = false;
  try {
    const r = await fetchOk(path.endsWith('/') ? path : path + '/');
    if (/html/i.test(r.headers.get('content-type') || '')) {
      listable = true;
      folders = linksIn(await r.text(), path).filter(h => h.endsWith('/')).map(h => h.replace(/\/$/, ''));
    }
  } catch (e) { /* not listable, or not there at all */ }

  if (!folders || !folders.length) {
    try {
      const r = await fetchOk(joinPath(path, 'sets.json'));
      const j = await r.json();
      folders = (Array.isArray(j) ? j : j.sets || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean);
    } catch (e) { /* no manifest either, which is fine */ }
  }

  if (folders && folders.length) {
    for (const f of folders) {
      const set = await scanOneLipFolder(joinPath(path, f), f);
      if (set) lips.sets.push(set);
    }
  }
  // Last resort: the folder itself holds the pictures. Only worth the nine
  // probes if the folder answered at all — otherwise that is nine 404s for a
  // directory that does not exist.
  if (!shippedSets().length && (listable || folders)) {
    const name = path.replace(/\/+$/, '').split('/').pop() || 'lips';
    const set = await scanOneLipFolder(path, name);
    if (set) lips.sets.push(set);
  }
  return shippedSets().length;
}

const shippedSets = () => lips.sets.filter(x => x.origin === 'shipped');
const sessionSets = () => lips.sets.filter(x => x.origin === 'session');

/* --- lips the viewer brings, for this visit only ----------------------------

   Everything here happens inside the viewer's own browser: the files are read
   with FileReader, drawn to a canvas, and held in memory. Nothing is uploaded,
   nothing reaches the server, and nothing is written to disk — no IndexedDB,
   no localStorage. Close the tab and the set is gone, which is the whole
   point: the app should not be quietly keeping copies of someone's artwork
   after they have finished with it, and one viewer's lips can never turn up in
   anyone else's page.
--------------------------------------------------------------------------- */

/** One folder is one set. If the folder the viewer picked holds subfolders,
    each of those becomes its own set instead — which is what happens when
    someone points at the parent rather than at one set. */
function groupPickedFiles(files) {
  const list = [...files].filter(f => IMG_RE.test(f.name));
  const groups = new Map();
  for (const f of list) {
    const parts = (f.webkitRelativePath || '').split('/').filter(Boolean);
    const key = parts.length >= 3 ? parts[1] : parts.length === 2 ? parts[0] : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: f.name, blob: f });
  }
  return [...groups.entries()].map(([name, blobs]) => ({ name, blobs }));
}

async function importLipFolder(files) {
  const groups = groupPickedFiles(files);
  if (!groups.length) { lipsSay('No images in that folder.', true); return 0; }
  let added = 0;
  for (const g of groups) {
    const name = g.name || 'My lips ' + (sessionSets().length + added + 1);
    const id = 's_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + Date.now().toString(36) +
               '_' + added;
    const set = await buildLipSet(id, name, g.blobs, 'session');
    if (!set) continue;
    lips.sets.push(set);
    added++;
  }
  buildLipChips();
  if (!added) { lipsSay('Those files did not decode as images.', true); return 0; }
  const last = lips.sets[lips.sets.length - 1];
  if (added === 1) useLipSet(last.id);
  sayShelf();
  // The moment to put a bad match right is the moment it happens — you have
  // just chosen the folder and you still remember what is in it. Only when
  // the names left something to guess; a folder named for the shapes is
  // already right and a dialog would only be in the way.
  if (added === 1 && last.guessed.length) openRemap(last.id);
  return added;
}

/** Only a set the viewer added can be taken away; the shipped ones are not
    theirs to remove. */
function removeLipSet(id) {
  const set = lips.sets.find(x => x.id === id);
  if (!set || set.origin !== 'session') return;
  lips.sets = lips.sets.filter(x => x.id !== id);
  if (lips.activeId === id) {
    lips.activeId = null; custom.on = false; custom.map = {}; custom.sources = [];
    buildStyleChips(); buildChart(); drawStage(); updateEstimates();
  }
  buildLipChips();
  sayShelf();
}

/* --- chips ---------------------------------------------------------------- */

function lipsSay(msg, warn) {
  const el = $('lipsStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('warn', !!warn);
}

function buildLipChips() {
  const wrap = $('lipsets');
  if (!wrap) return;
  wrap.innerHTML = '';
  // Shipped first, then anything the viewer brought — the ones that are always
  // here should not shuffle about as sets are added and dropped.
  shippedSets().concat(sessionSets()).forEach(set => {
    const b = document.createElement('button');
    b.className = 'style-opt' + (lips.activeId === set.id ? ' sel' : '');
    b.type = 'button';
    b.title = set.name + ' — ' + (9 - set.guessed.length) + ' of 9 shapes named, ' +
      set.count + ' picture' + (set.count === 1 ? '' : 's') + ' in the folder' +
      (set.origin === 'session' ? ' · yours, this visit only' : '');
    // Drawn straight from this set, not through paintMouth — the chip has to
    // show its own art whether or not the set is the one in use.
    const c = document.createElement('canvas');
    c.width = 120; c.height = 94;
    const cx2 = c.getContext('2d');
    const src = set.map.C || set.map.A || Object.values(set.map)[0];
    if (src && src.img) {
      const s = Math.min(120 / src.sw, 94 / src.sh);
      cx2.drawImage(src.img, src.sx, src.sy, src.sw, src.sh,
                    (120 - src.sw * s) / 2, (94 - src.sh * s) / 2, src.sw * s, src.sh * s);
    }
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = set.name;
    if (set.guessed.length) {
      const w = document.createElement('span');
      w.className = 'chip-note';
      w.textContent = (9 - set.guessed.length) + '/9';
      b.appendChild(w);
    }
    b.append(c, nm);
    if (set.origin === 'session') {
      const x = document.createElement('span');
      x.className = 'chip-x';
      x.textContent = '×';
      x.title = 'Remove — this set is only here for this visit anyway';
      x.onclick = e => { e.stopPropagation(); removeLipSet(set.id); };
      b.appendChild(x);
      b.classList.add('mine');
    }
    b.onclick = () => useLipSet(set.id);
    wrap.appendChild(b);
  });
  syncRemapButton();
}

/* --- which picture is which shape -------------------------------------------

   The automatic match reads filenames, which is right most of the time and
   wrong in ways nothing else can put right: a folder of 1.png … 9.png carries
   no clue at all, and one that calls its wide-open shape "aah" lands it on A.
   Renaming the files and importing again does work, but it is a poor answer
   once the set is on the page and you can see which frame is wrong. So the
   assignment stays editable, one shape at a time, with the chart and the stage
   following as you go — the picture you are choosing is a picture you can see.
--------------------------------------------------------------------------- */

let remapSetId = null;

/** One picture, letterboxed into a canvas. Drawn straight from the set rather
    than through paintMouth, so it shows its own art whether or not the set is
    the one in use. */
function drawPicInto(c, src) {
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  if (!src || !src.img) return;
  const s = Math.min(c.width / src.sw, c.height / src.sh);
  x.drawImage(src.img, src.sx, src.sy, src.sw, src.sh,
              (c.width - src.sw * s) / 2, (c.height - src.sh * s) / 2,
              src.sw * s, src.sh * s);
}

function sayRemap() {
  const set = lipSetById(remapSetId), el = $('remapSub');
  if (!set || !el) return;
  const n = set.guessed.length;
  el.textContent = set.name + ' — ' + set.count + ' picture' +
    (set.count === 1 ? '' : 's') + ' in the folder. ' +
    (n === 0 ? 'Every shape has a picture named for it.'
     : n === 1 ? 'One shape has no picture named for it, and is marked.'
     : n + ' shapes have no picture named for them, and are marked.');
}

function buildRemapRows() {
  const set = lipSetById(remapSetId), wrap = $('remapRows');
  if (!set || !wrap) return;
  sayRemap();
  wrap.innerHTML = '';
  VIS.forEach(v => {
    const row = document.createElement('div');
    row.className = 'remap-row' + (set.guessed.includes(v) ? ' guess' : '');

    const key = document.createElement('div');
    key.className = 'remap-key';
    key.style.setProperty('--k', VCOL[v]);
    const tag = document.createElement('b');
    tag.textContent = v;
    const nm = document.createElement('span');
    nm.textContent = VNAME[v];
    nm.title = VNAME[v];
    key.append(tag, nm);

    const c = document.createElement('canvas');
    c.className = 'remap-thumb';
    c.width = 116; c.height = 90;
    drawPicInto(c, set.map[v]);

    const sel = document.createElement('select');
    sel.className = 'remap-pick';
    sel.setAttribute('aria-label', 'Picture for ' + v + ' — ' + VNAME[v]);
    set.pics.forEach((pic, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = pic.name;
      if (set.by[v] === i) o.selected = true;
      sel.appendChild(o);
    });
    // Live, not on OK. Rebuilding every row here would take the focus out of
    // the control being used, so only what changed is redrawn.
    sel.onchange = () => {
      assignShape(set, v, +sel.value);
      drawPicInto(c, set.map[v]);
      row.classList.remove('guess');
      sayRemap();
    };

    row.append(key, c, sel);
    wrap.appendChild(row);
  });
}

function openRemap(id) {
  const set = lipSetById(id || lips.activeId);
  if (!set) return;
  remapSetId = set.id;
  // Editing a set you cannot see would be guesswork of a different kind.
  if (lips.activeId !== set.id) useLipSet(set.id, true);
  buildRemapRows();
  const d = $('remapDlg');
  if (!d) return;
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}

function wireRemap() {
  const d = $('remapDlg');
  if (!d) return;
  $('lipsRemap').onclick = () => openRemap(lips.activeId);
  $('remapAuto').onclick = () => {
    const set = lipSetById(remapSetId);
    if (!set) return;
    const auto = autoAssign(set.pics);
    set.by = auto.by; set.guessed = auto.guessed;
    relinkLipSet(set);
    if (lips.activeId === set.id) useLipSet(set.id, true);
    buildRemapRows();
  };
  d.addEventListener('close', () => { remapSetId = null; });
}

/** The button is only meaningful with a set in front of you. */
function syncRemapButton() {
  const b = $('lipsRemap');
  if (!b) return;
  const set = lipSetById(lips.activeId);
  b.disabled = !set;
  b.title = set ? 'Say which picture belongs to which shape in “' + set.name + '”'
                : 'Pick a set of lips first';
}

/* --- the two shelves ------------------------------------------------------ */

const STYLE_TABS = ['builtin', 'mine'];
const VIEW_TABS = ['front', 'three', 'profile'];
let viewTab = 'front';

function showViewTab(name) {
  if (!VIEW_TABS.includes(name)) return;
  viewTab = name;
  VIEW_TABS.forEach(t => {
    const pane = $('viewpane-' + t), btn = $('viewBtn-' + t);
    if (!pane || !btn) return;
    pane.hidden = t !== name;
    btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
    btn.classList.toggle('on', t === name);
    btn.tabIndex = t === name ? 0 : -1;
  });
}
let styleTab = 'builtin';

function showStyleTab(name) {
  if (!STYLE_TABS.includes(name)) return;
  styleTab = name;
  STYLE_TABS.forEach(t => {
    const pane = $('stylepane-' + t), btn = $('styleBtn-' + t);
    pane.hidden = t !== name;
    btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
    btn.tabIndex = t === name ? 0 : -1;
  });
  // Canvases in a hidden pane have no layout, so redraw on the way in.
  if (name === 'builtin') buildStyleChips(); else buildLipChips();
}

function wireStyleTabs() {
  STYLE_TABS.forEach(t => { $('styleBtn-' + t).onclick = () => showStyleTab(t); });
  $('styleBtn-builtin').parentElement.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = STYLE_TABS.indexOf(styleTab);
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + STYLE_TABS.length) % STYLE_TABS.length;
    showStyleTab(STYLE_TABS[n]);
    $('styleBtn-' + STYLE_TABS[n]).focus();
  });
}

/* --- start-up ------------------------------------------------------------- */

/** The shelf is always there, because a viewer can always bring their own
    lips even when nothing has been curated into LIPS_DIR. */
function sayShelf() {
  const ship = shippedSets().length, mine = sessionSets().length;
  const bits = [];
  if (ship) bits.push(ship + ' set' + (ship === 1 ? '' : 's') + ' from ' + LIPS_DIR);
  if (mine) bits.push(mine + ' of your own, for this visit only');
  lipsSay(bits.join(' · '));
}

async function initLipSets() {
  wireStyleTabs();
  wireRemap();
  // Built-in lips, and Front inside it, every time the page opens. Neither
  // choice is remembered: a set brought in last visit is gone on reload anyway,
  // so reopening on Custom lips would land on an empty shelf, and a page that
  // reopens on Profile because that is where someone was last week costs more
  // than it saves. Both are one click away.
  showStyleTab('builtin');
  try {
    localStorage.removeItem('mouthchart.styleTab');
    localStorage.removeItem('mouthchart.viewTab');
  } catch (e) {}

  VIEW_TABS.forEach(t => {
    const b = $('viewBtn-' + t);
    if (b) b.onclick = () => showViewTab(t);
  });
  const vtabs = $('viewTabs');
  if (vtabs) vtabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = VIEW_TABS.indexOf(viewTab);
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + VIEW_TABS.length) % VIEW_TABS.length;
    showViewTab(VIEW_TABS[n]);
    $('viewBtn-' + VIEW_TABS[n]).focus();
  });
  showViewTab('front');

  $('lipsPick').onclick = () => $('lipsInput').click();
  $('lipsInput').onchange = async () => {
    // FileList is live: copy it out before clearing the input, or the list
    // empties underneath us.
    const files = [...$('lipsInput').files];
    $('lipsInput').value = '';
    lipsSay('Reading…');
    await importLipFolder(files);
  };

  if (!servedOverHttp()) {
    // Only ever seen by whoever is building the page, since anything deployed
    // is served. A visitor never sees this.
    console.info('lip sets: ' + LIPS_DIR + ' can only be read when the page is served over http.');
  } else {
    try { await scanLipFolder(LIPS_DIR); }
    catch (e) { console.warn('could not read ' + LIPS_DIR, e); }
  }
  buildLipChips();
  sayShelf();
}

/* ---- diagnostics ----------------------------------------------------------
   Browser behaviour around video differs enough between engines that guessing
   from a screenshot wastes everyone's time. This states what the page can see.
--------------------------------------------------------------------------- */

const MEDIA_ERR = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };

function diagnostics() {
  const v = player;
  const err = v && v.error;
  const lines = [
    'Lip Sync Generator diagnostics',
    'version    : ' + APP_VERSION,
    'agent      : ' + navigator.userAgent,
    'file       : ' + (state.name || '—'),
    'audio      : ' + (state.buffer
      ? state.buffer.duration.toFixed(2) + 's, ' + Math.round(state.buffer.sampleRate) + ' Hz, ' +
        state.buffer.numberOfChannels + ' ch'
      : 'none'),
    'audio route: ' + (state.srcAudio ? 'copyable AAC track found' : 'no copyable track'),
    'video      : ' + (state.video ? state.video.w + '×' + state.video.h : 'none reported') +
      (state.videoCodec ? ' ' + state.videoCodec.format + ' (' + state.videoCodec.name + ')' : ''),
    'decodable  : ' + state.videoDecodable,
    'element    : display=' + (v ? getComputedStyle(v).display : '?') +
      ' readyState=' + (v ? v.readyState : '?') +
      ' networkState=' + (v ? v.networkState : '?') +
      ' t=' + (v ? (v.currentTime || 0).toFixed(2) : '?'),
    'element err: ' + (err ? (MEDIA_ERR[err.code] || err.code) + ' ' + (err.message || '') : 'none'),
    'buffered   : ' + (v && v.buffered && v.buffered.length
      ? v.buffered.start(0).toFixed(2) + '–' + v.buffered.end(v.buffered.length - 1).toFixed(2) + 's'
      : 'nothing'),
    'engine     : ' + ENGINES[engine].label + ', ' + state.fps + ' fps, ' + state.frames.length + ' frames',
    'codecs     : VideoEncoder=' + (typeof VideoEncoder !== 'undefined') +
      ' AudioDecoder=' + (typeof AudioDecoder !== 'undefined') +
      ' AAC-encode=' + aacEncoderAvailable,
    'canPlayType: mov=' + (v ? (v.canPlayType('video/quicktime') || 'no') : '?') +
      ' mp4=' + (v ? (v.canPlayType('video/mp4') || 'no') : '?') +
      ' hevc=' + (v ? (v.canPlayType('video/mp4; codecs="hvc1"') || 'no') : '?'),
    'touch      : maxTouchPoints=' + navigator.maxTouchPoints,
    'overlay    : static at ' + overlay.x.toFixed(3) + ',' + overlay.y.toFixed(3) +
      ' size ' + overlay.size.toFixed(3) + ' rot ' + overlay.rot.toFixed(1),
    'patch      : ' + (patch.on ? 'on, blur ' + Math.round(patch.blur * 100) +
      '% cover ' + Math.round(patch.cover * 100) + '%' : 'off') +
      ', blur=resample'
  ];
  return lines.join('\n');
}

function refreshDiagnostics() {
  const el = $('diagText');
  if (el) el.textContent = diagnostics();
}

/* --------------------------------------------------------------- chrome */

function buildStyleChips() {
  // One grid per head angle. Each holds the same fifteen styles, so a character
  // keeps its look through a turn — which is the whole point of having them.
  STYLE_VIEWS.forEach(view => buildStyleGrid(view));
}

function buildStyleGrid(view) {
  const wrap = $(view === 'front' ? 'styles' : 'styles-' + view);
  if (!wrap) return;
  wrap.innerHTML = '';
  stylesInView(view).forEach(id => {
    const b = document.createElement('button');
    b.className = 'style-opt' + (!custom.on && state.style === id ? ' sel' : '');
    b.type = 'button';
    const c = document.createElement('canvas');
    c.width = 120; c.height = 94;
    const cx2 = c.getContext('2d');
    cx2.setTransform(1.5, 0, 0, 1.5, -0.25 * 120, -0.25 * 94);
    STYLES[id].draw(cx2, 120, 94, 'C');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = STYLES[id].label;
    b.append(c, nm);
    b.onclick = () => {
      state.style = id; custom.on = false; custom.map = {}; custom.sources = [];
      if (typeof lips !== 'undefined') { lips.activeId = null; buildLipChips(); }
      buildStyleChips(); buildChart(); drawStage(); updateEstimates();
      // The choice belongs to the open clip, so its row has to show it now,
      // not after the next switch.
      const c = activeClip();
      if (c) { c.style = id; c.lipSetId = null; }
      renderQueue();
    };
    wrap.appendChild(b);
  });
}

function buildChart() {
  const wrap = $('chart');
  wrap.innerHTML = '';
  VIS.forEach(v => {
    const d = document.createElement('button');
    d.className = 'cell';
    d.type = 'button';
    d.title = VNAME[v];
    const c = document.createElement('canvas');
    c.width = 150; c.height = 116;
    const cx2 = c.getContext('2d');
    cx2.setTransform(1.35, 0, 0, 1.35, -0.175 * 150, -0.175 * 116);
    paintMouth(cx2, 150, 116, v, state.style);
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = v;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.background = VCOL[v];
    d.append(c, k, bar);
    d.onclick = () => {
      if (state.frames.length) {
        const [a, b] = selRange();
        setViseme(v);
        toast((a === b ? 'Frame ' + (a + 1) : 'Frames ' + (a + 1) + '–' + (b + 1)) +
              ' set to ' + v + ' — ' + VNAME[v], 1800);
      } else {
        const ctx = $('stage').getContext('2d');
        paintMouth(ctx, $('stage').width, $('stage').height, v, state.style);
        $('badgeViseme').textContent = v;
      }
    };
    wrap.appendChild(d);
  });
}

function buildLegend() {
  $('legend').innerHTML = VIS.map(v =>
    '<span class="lg" title="' + VNAME[v] + '"><i style="background:' + VCOL[v] + '"></i>' + v + '</span>'
  ).join('');
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  const drop = $('drop'), input = $('fileInput');
  drop.onclick = () => input.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  // A live FileList empties when the input is cleared, so copy it out first.
  input.onchange = () => { const f = [...input.files]; input.value = ''; addFiles(f); };
  ['dragenter', 'dragover'].forEach(ev =>
    document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    document.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      drop.classList.remove('over');
    }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    // A photograph cannot be a clip — there is no audio in it to analyse — so a
    // dropped image is never ambiguous: it is the puppet. Which also means a
    // WAV and a JPG dropped together do the obvious thing in one gesture.
    if (f.type.startsWith('image/')) {
      if (!state.frames.length) {
        toast('Drop a voice track first — a puppet needs something to say.', 4200);
        return;
      }
      setPuppet(f);
      return;
    }
    // A video dropped onto the STAGE is a backdrop; dropped anywhere else it is
    // a clip of its own. Position is the only thing that can tell them apart.
    const onStage = $('stageWrap') && $('stageWrap').contains(e.target);
    if (onStage && state.frames.length && /^video\//.test(f.type)) {
      setPuppet(f);
      return;
    }
    addFiles(e.dataTransfer.files);
  });

  const pick = $('puppetInput');
  const offer = () => pick.click();
  $('puppetPick').onclick = offer;
  $('plateSwap').onclick = offer;
  $('plateDrop').onclick = () => { forgetPuppet(); toast('Puppet removed.', 1800); };
  // Trim and untrim. The untrimmed original is kept on the clip, so this is a
  // real toggle rather than a one-way door — and it reloads through setPuppet
  // so the placement, the clip's record and the Final Cut copy all move
  // together with the picture.
  $('plateCrop').onclick = async () => {
    if (puppet.kind !== 'image') return;
    const keep = pose();
    /* The mouth is placed in fractions of the frame, and trimming changes the
       frame — so the same fractions put it somewhere else on the face. Both
       directions are worked out from the kept region: where the content sat in
       the original, plus the 20px margin put back. Without this, trimming
       slides the mouth off the chin and undoing it slides it back, which looks
       like the button is broken rather than like arithmetic. */
    const remap = (box, from, to, sign) => {
      const o = { x: box.x - box.m, y: box.y - box.m };
      if (sign > 0) {   // original -> trimmed
        return { x: (keep.x * from.w - o.x) / to.w, y: (keep.y * from.h - o.y) / to.h,
                 size: keep.size * from.w / to.w, rot: keep.rot };
      }
      return { x: (keep.x * from.w + o.x) / to.w, y: (keep.y * from.h + o.y) / to.h,
               size: keep.size * from.w / to.w, rot: keep.rot };
    };
    if (puppet.cropped) {
      const back = puppet.uncropped, box = puppet.cropBox;
      if (!back) return;
      const was = { w: puppet.w, h: puppet.h };
      const ok = await setPuppet(back, true, { noCrop: true });
      if (ok) {
        if (box) Object.assign(overlay, remap(box, was, { w: puppet.w, h: puppet.h }, -1));
        else Object.assign(overlay, keep);
        drawStage();
        toast('Original picture restored.', 2200);
      }
      return;
    }
    const c = activeClip();
    const f = (c && c.puppet && c.puppet.file) || null;
    if (!f) return;
    const r = await cropToContent(f, true);
    if (!r) { toast('Nothing to trim — the picture runs to its own edges.', 3200); return; }
    const ok = await setPuppet(r.file, true,
                               { noCrop: true, uncropped: f, cropBox: r.box });
    if (ok) {
      Object.assign(overlay, remap(r.box, r.from, r.to, 1));
      drawStage();
      toast('Trimmed to ' + r.to.w + '×' + r.to.h + ' from ' +
            r.from.w + '×' + r.from.h + '.', 3000);
    }
  };
  pick.onchange = () => {
    const f = pick.files && pick.files[0];
    pick.value = '';
    if (f) setPuppet(f);
  };
  PLATE_BOXES.forEach(({ id }) => { const b = $(id); if (b) b.onchange = updateEstimates; });
  FX_BOXES.forEach(id => { const b = $(id); if (b) b.onchange = updateEstimates; });
  $('clearBtn').onclick = () => (queue.clips.length ? removeClip(queue.activeId) : clearAudio());
  $('playAllBtn').onclick = playAllRun;
  // One answer for the whole tab; a card can still be set on its own after.
  ['scopeAll', 'scopeOne'].forEach(id => {
    const b = $(id);
    if (!b) return;
    b.onclick = () => {
      Object.keys(EXPORT_CARDS).forEach(k => { cardScope[k] = b.dataset.scope; });
      updateBatchUI();
      updateEstimates();
    };
  });
  $('queueAdd').onclick = () => $('fileInput').click();
  $('queueClear').onclick = clearQueue;
  $('expSceneApng').onclick = () => exportConversation('apng');
  $('expSceneGif').onclick = () => exportConversation('gif');
  $('castDeal').onclick = async () => {
    const btn = $('castDeal');
    btn.disabled = true;
    try {
      const order = castRunningOrder();
      const n = await castAlternate(order);
      toast(n
        ? (order.length < 2
            ? castLabel(order[0]) + ' is on all ' + n + ' clips.'
            : 'Cast ' + n + ' clips — ' + order.map(castLabel).join(', ') + ', in turn.')
        : 'Cast a clip or two first — click a face while a clip is open.', 5000);
    } finally {
      renderCastBar();
    }
  };
  $('batchStop').onclick = () => { batchAbort = true; batchSay('Stopping after this clip…'); };
  updateBatchUI();

  $('fps').onchange = () => { state.dirty = false; runAnalysis(); };
  const es = $('engineSel');
  if (!ENGINES.rhubarb.available()) {
    const opt = es.querySelector('option[value="rhubarb"]');
    opt.disabled = true;
    opt.textContent = 'Rhubarb — in the downloadable copy';
  }
  es.onchange = () => { engine = es.value; state.dirty = false; syncEngineUI(); runAnalysis(); };
  const bind = (id, key, fmt) => {
    const el = $(id);
    el.oninput = () => {
      cfg[key] = parseFloat(el.value);
      $(id + 'Val').textContent = fmt(cfg[key]);
      clearTimeout(bind._t);
      bind._t = setTimeout(runAnalysis, 180);
    };
  };
  bind('gate', 'gate', v => v + ' dB');
  bind('vs', 'vs', v => v.toFixed(2));
  bind('hold', 'hold', v => v + (v === 1 ? ' frame' : ' frames'));
  $('closures').onchange = e => { cfg.closures = e.target.checked; runAnalysis(); };
  $('detectL').onchange = e => { cfg.detectL = e.target.checked; runAnalysis(); };
  $('resetBtn').onclick = () => {
    Object.assign(cfg, { gate: 12, vs: 1, hold: 2, closures: true, detectL: false });
    $('gate').value = 12; $('gateVal').textContent = '12 dB';
    $('vs').value = 1; $('vsVal').textContent = '1.00';
    $('hold').value = 2; $('holdVal').textContent = '2 frames';
    $('closures').checked = true; $('detectL').checked = false;
    state.dirty = false;
    state.frames.forEach(f => f.edited = false);
    $('clearEdits').disabled = true;
    runAnalysis();
  };
  $('clearEdits').onclick = () => {
    state.dirty = false;
    state.frames.forEach(f => f.edited = false);
    $('clearEdits').disabled = true;
    runAnalysis();
  };
  /* ⌘Z, with two histories to choose between.

     The sheet and the stage keep their own, because a frame's shape and a
     layer's placement are not the same kind of thing and a single stack of
     both would undo across them in an order nobody could predict. But a
     person pressing ⌘Z means "take back what I just did", so the key goes to
     whichever of the two was touched most recently. Each history stamps
     itself from one counter, which is all it takes to know. */
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      // The timeline answers only when it is the surface in hand — see
      // lastSurface — so a ⌘Z meant for a mouth shape never re-cuts a clip.
      if (timelineInHand()) { e.shiftKey ? timeRedo() : timeUndo(); return; }
      // Which action is next in line on each stack, by the moment it happened.
      // Undoing walks backwards through the most recent first; redoing walks
      // forwards through the earliest first, so a run of presses retraces the
      // same path it undid.
      const stamp = (h, i) => (h.stack[i] && h.stack[i].at) || 0;
      const stageNext = e.shiftKey
        ? (stageHistory.at < stageHistory.stack.length - 1 ? stamp(stageHistory, stageHistory.at + 1) : Infinity)
        : (stageHistory.at > 0 ? stamp(stageHistory, stageHistory.at) : -1);
      const sheetNext = e.shiftKey
        ? (history.at < history.stack.length - 1 ? stamp(history, history.at + 1) : Infinity)
        : (history.at > 0 ? stamp(history, history.at) : -1);
      const stageFirst = e.shiftKey ? stageNext <= sheetNext : stageNext >= sheetNext;
      const tryStage = () => e.shiftKey ? stageRedo() : stageUndo();
      const trySheet = () => {
        const before = history.at;
        e.shiftKey ? redo() : undo();
        return history.at !== before;
      };
      // Whichever is newer gets first refusal; if it has nothing left to take
      // back, the other one answers rather than the key doing nothing.
      if (stageFirst) { if (!tryStage()) trySheet(); }
      else { if (!trySheet()) tryStage(); }
    }
  });
  $('stageUndo').onclick = () => stageUndo();
  $('stageRedo').onclick = () => stageRedo();

  // overlay placement: drag the mouth, pull the corner to scale it,
  // swing the knob on top to turn it
  const stage = $('stage');
  let ovMode = null, ovStart = null;
  const stagePt = e => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * stage.width,
             y: (e.clientY - r.top) / r.height * stage.height };
  };
  /* Which handle a point is on, judged in the box's own frame. The turn knob
     is tested first: it stands outside the box, but at small sizes its catch
     radius can reach back over the corner. */
  const ovHit = p => {
    const b = activeBox(stage.width, stage.height);
    const g = overlayHandles(b, stage.width, stage.height);
    const l = overlayLocal(p, b);
    const near = (q, r) => Math.abs(l.x - q.x) < r && Math.abs(l.y - q.y) < r;
    if (near(g.turn, g.hs * 1.9)) return { mode: 'turn', b, l };
    const cs = g.corners || [g.scale];
    for (let i = 0; i < cs.length; i++) {
      if (near(cs[i], g.hs * 1.6)) return { mode: 'scale', corner: i, b, l };
    }
    if (Math.abs(l.x) <= g.hw && Math.abs(l.y) <= g.h) return { mode: 'move', b, l };
    return { mode: null, b, l };
  };

  stage.addEventListener('pointerdown', e => {
    // "Is there anything to place", not "is there a puppet". A picture added
    // through the Layers tab is not a puppet — the puppet row still says
    // nothing is behind the mouth — and gating the whole pointer handler on
    // hasPlate() meant that in that state the handles DREW THEMSELVES and did
    // nothing at all. Reported as "the resize box and tilt handle are viewable
    // but not active", which is exactly what an early return looks like.
    if (!placeable()) return;
    const p = stagePt(e);
    let hit = ovHit(p);
    // A corner or the turn knob belongs to whatever is already selected, and is
    // tested first so a handle that sticks out past a neighbour still works.
    // Anything else SELECTS WHAT WAS CLICKED ON before it moves it. Without
    // this the pointer could only ever drive the layer the list had selected,
    // which made the mouth unreachable behind any full-frame picture.
    if (hit.mode !== 'turn' && hit.mode !== 'scale') {
      const under = layerAtPoint(p, stage.width, stage.height);
      if (under && under.id !== selectedLayerId) {
        selectLayer(under.id);
        syncLayerSelect();
        hit = ovHit(p);
      }
    }
    if (!hit.mode) return;
    ovMode = hit.mode;
    const o = activePose();
    ovStart = {
      p, l: hit.l, x: o.x, y: o.y, size: o.size, rot: o.rot,
      dist: Math.hypot(hit.l.x, hit.l.y),
      ang: Math.atan2(p.y - hit.b.cy, p.x - hit.b.cx),
      // What the mouth looked like before the drag started. Every move is
      // recomputed from this rather than from the last frame, so a long drag
      // cannot accumulate rounding into a visible drift.
      mouth0: { x: overlay.x, y: overlay.y, size: overlay.size, rot: overlay.rot },
    };
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* drag works without it */ }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', e => {
    if (!ovMode) {
      if (placeable()) {
        const hit = ovHit(stagePt(e));
        const m = hit.mode;
        // A turned box turns its corners with it, so the resize cursor has to
        // follow — otherwise it points across the box instead of out of it.
        // Which diagonal also depends on WHICH corner: the two on one diagonal
        // are nwse, the two on the other nesw.
        const q = ((Math.round(activePose().rot / 90) % 4) + 4) % 4;
        const diag = ((hit.corner || 0) % 2) ^ (q % 2);
        stage.style.cursor = m === 'turn' ? 'grab'
          : m === 'scale' ? (diag ? 'nesw-resize' : 'nwse-resize')
          : m === 'move' ? 'move' : '';
      }
      return;
    }
    const p = stagePt(e);
    const o = activePose();
    const sel = selectedLayer();
    const pup = activeIsPlate();
    const isMouth = !!sel && sel.kind === 'mouth';
    if (ovMode === 'move') {
      o.x = clamp(ovStart.x + (p.x - ovStart.p.x) / stage.width, -0.2, 1.2);
      o.y = clamp(ovStart.y + (p.y - ovStart.p.y) / stage.height, -0.2, 1.2);
    } else if (ovMode === 'turn') {
      const b = activeBox(stage.width, stage.height);
      const a = Math.atan2(p.y - b.cy, p.x - b.cx);
      let deg = ovStart.rot + (a - ovStart.ang) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;   // shift snaps to 15°
      o.rot = normDeg(deg);
    } else {
      // Scale on the distance from the centre, not on screen-x: the corner
      // being dragged has moved round with the box, so a plain x delta would
      // shrink the box when you pull away from it on a turned overlay.
      const b = activeBox(stage.width, stage.height);
      const l = overlayLocal(p, b);
      const d = Math.hypot(l.x, l.y);
      // The puppet gets a wider range: it starts at 1 — filling the frame —
      // so the useful moves are mostly downward, and 4x is enough to push in
      // on a face that was photographed from across the room.
      // The puppet gets a wider range: it starts at 1 — filling the frame —
      // so the useful moves are mostly downward. The mouth is never bigger
      // than the frame and a half. Everything else sits between the two.
      const k = ovStart.size * d / Math.max(1e-6, ovStart.dist);
      o.size = pup ? clamp(k, 0.08, 4) : isMouth ? clamp(k, 0.04, 1.6) : clamp(k, 0.02, 4);
    }
    if (pup) {
      // THE MOUTH ONLY. The puppet and the mouth are one thing — the mouth is
      // placed on the face and means nothing anywhere else, so moving the face
      // has to take it along or the placement is destroyed by every nudge.
      //
      // Nothing else in the stack is bound to the puppet that way. A caption,
      // a prop, a background, a second character: those are placed in the
      // FRAME, and dragging them around whenever the puppet moved made the
      // puppet impossible to adjust without wrecking the composition. They
      // move separately, which is what a layer normally means.
      const p0 = { x: ovStart.x, y: ovStart.y, size: ovStart.size, rot: ovStart.rot };
      const m = remapWithPuppet(p0, o, ovStart.mouth0, stage.width, stage.height);
      overlay.x = m.x; overlay.y = m.y; overlay.size = m.size; overlay.rot = m.rot;
      syncPlateTransform();
    }
    updateOverlayReadout();
    drawStage();
  });
  const endOverlay = e => {
    if (!ovMode) return;
    ovMode = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
    if (activeIsPlate()) {
      const c = activeClip();
      if (c) c.puppetPose = { ...puppetPose };
      const sh = activeShelfEntry();
      if (sh) sh.pose = { ...puppetPose };
      updateEstimates();
      updateBatchUI();
    }
    bankLayers();
    renderLayerPanel();
    // One step per drag, not one per pointermove.
    pushStageHistory();
  };
  stage.addEventListener('pointerup', endOverlay);
  stage.addEventListener('pointercancel', endOverlay);
  $('flipLips').onclick = () => {
    mirror.lips = !mirror.lips;
    const c = activeClip(); if (c) c.mirror = { ...mirror };
    syncMirrorUI();
    buildChart(); drawStage(); updateEstimates();
    toast(mirror.lips ? 'Lips mirrored — they now face left.'
                      : 'Lips back the way they were drawn.', 1800);
  };
  $('plateFlip').onclick = () => {
    mirror.plate = !mirror.plate;
    const c = activeClip(); if (c) c.mirror = { ...mirror };
    syncPuppetUI();
    syncPlateTransform();
    drawStage();
    toast(mirror.plate ? 'Puppet mirrored.' : 'Puppet back the way it was.', 1800);
  };
  $('overlayReset').onclick = () => {
    if (activeIsPlate()) {
      Object.assign(puppetPose, PUPPET_POSE);
      const c = activeClip(); if (c) c.puppetPose = { ...puppetPose };
      const sh = activeShelfEntry(); if (sh) sh.pose = { ...puppetPose };
      syncPlateTransform(); updateOverlayReadout(); drawStage(); updateEstimates();
      return;
    }
    overlay.x = 0.5; overlay.y = 0.66; overlay.size = 0.30; overlay.rot = 0;
    updateOverlayReadout(); drawStage(); drawOverview();
  };
  $('layerSelect').addEventListener('change', e => selectLayer(e.target.value));
  $('layerAddImage').onclick = () => $('layerImageInput').click();
  // The same thing, offered from the puppet row, because that is where someone
  // who has just added one picture is standing when they want a second.
  $('layerImageInput').onchange = e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) addImageLayerFromFile(f);
  };
  $('layerAddText').onclick = addTextLayer;
  $('layerAddShape').onclick = addShapeLayer;
  $('layerAddBalloon').onclick = () => addBalloonLayer('speech');

  /* The size and the angle of whatever the handles are on, as sliders. The
     size one is the fix for "a picture arrives too big and the only way down
     is to type percentages at it"; the angle one matters when you are matching
     a head tilted by a known amount. Both write to activePose(), so they
     follow the selection like the handles do. */
  const placeSlider = (id, apply) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      const was = activeIsPlate() ? { ...activePose() } : null;
      const mouth0 = { x: overlay.x, y: overlay.y, size: overlay.size, rot: overlay.rot };
      apply(v, activePose());
      // Resizing or turning the PUPPET carries the mouth with it, exactly as
      // dragging it does — otherwise the slider and the handles disagree about
      // what moving a character means. Only the mouth: see the drag handler.
      if (was) {
        const o = activePose();
        const st = $('stage');
        const m = remapWithPuppet(was, o, mouth0, st.width, st.height);
        overlay.x = m.x; overlay.y = m.y; overlay.size = m.size; overlay.rot = m.rot;
        const c = activeClip(); if (c) c.puppetPose = { ...puppetPose };
        const sh = activeShelfEntry(); if (sh) sh.pose = { ...puppetPose };
        syncPlateTransform();
      }
      bankLayers();
      updateOverlayReadout();
      drawStage();
      renderLayerPanel();
      updateEstimates();
    });
    el.addEventListener('change', () => {
      updateOverlayReadout(); drawStage();
      // The strip's sliders and number fields are stage actions too, and a
      // slider dragged across its range should take ONE press to take back.
      pushStageHistory();
    });
    el.addEventListener('input', () => pushStageHistorySoon(600));
  };
  const setRot = (v, o) => { o.rot = normDeg(v); };
  const setSize = (v, o) => { o.size = clamp(v / 100, 0.02, 4); };
  placeSlider('overlayAngle', setRot);
  placeSlider('overlaySizeRange', setSize);
  // The number fields run the same code. Two paths to one value is how they
  // drift apart, and this one has an awkward failure — the field writes the
  // pose but not the puppet's remap, so a typed size would move the character
  // and leave the mouth behind.
  placeSlider('overlayAngleNum', setRot);
  placeSlider('overlaySizeNum', setSize);
  // Enter commits and gets out of the way, so the readouts can refresh.
  ['overlayAngleNum', 'overlaySizeNum'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
    if (el) el.addEventListener('blur', () => { updateOverlayReadout(); drawStage(); });
  });

  $('overlayDelete').onclick = () => {
    const L = selectedLayer();
    if (!L || L.kind === 'mouth') return;
    deleteLayer(L.id);
  };

  /* ---- blur patch ---- */
  $('patchOn').addEventListener('change', () => {
    patch.on = $('patchOn').checked;
    drawStage();
  });
  const patchSlider = () => {
    patch.blur = parseFloat($('patchBlur').value) / 100;
    patch.cover = parseFloat($('patchCover').value) / 100;
    if (patch.on) drawStage();
  };
  $('patchBlur').addEventListener('input', patchSlider);
  $('patchCover').addEventListener('input', patchSlider);

  $('diagCopy').onclick = async () => {
    refreshDiagnostics();
    try {
      await navigator.clipboard.writeText(diagnostics());
      toast('Diagnostics copied.', 1800);
    } catch (e) {
      toast('Select the text above and copy it manually.', 3000);
    }
  };
  $('diagBox').addEventListener('toggle', () => { if ($('diagBox').open) refreshDiagnostics(); });

  $('scriptAlign').onclick = () => {
    if (!state.frames.length) { toast('Load a track first.', 2200); return; }
    const r = alignScript($('scriptText').value);
    $('scriptStatus').textContent = state.script.length
      ? r.words + ' words spread across ' + r.phrases + ' phrases.' +
        (r.crowded ? ' More words than there is speech here — check the script matches the take.'
                   : ' Re-align after changing the frame rate or gate.')
      : 'Nothing to align — paste a script, and check the sheet has speech in it.';
    layoutSheet(); drawSheet();
  };
  $('scriptClear').onclick = () => {
    $('scriptText').value = '';
    state.script = [];
    $('scriptStatus').textContent = 'Cleared.';
    layoutSheet(); drawSheet();
  };

  // Touching the transport by hand is "I will drive now", so it ends a
  // play-all rather than fighting it for the element.
  $('playBtn').onclick = () => { playAllStop(true); togglePlay(); };
  $('stopBtn').onclick = () => { playAllStop(true); stopPlayback(true); };
  $('headBtn').onclick = () => jumpTo('start');
  $('tailBtn').onclick = () => jumpTo('end');
  $('loopBtn').onclick = () => {
    setLooping(!looping);
    toast(looping ? 'Looping.' : 'Loop off.', 1400);
  };
  $('checkerToggle').onchange = e => $('stageWrap').classList.toggle('plain', !e.target.checked);

  const sc = $('xsScroll'), xs = $('xsheet');
  sc.addEventListener('scroll', () => drawSheet(), { passive: true });

  const frameAt = clientX => {
    const r = xs.getBoundingClientRect();
    return Math.floor((sc.scrollLeft + clientX - r.left) / CW);
  };
  let dragging = false, touchStart = null;
  xs.addEventListener('pointerdown', e => {
    if (!state.frames.length) return;
    if (e.pointerType === 'touch') {
      // let the sheet scroll under the finger; a tap still picks a frame
      touchStart = { x: e.clientX, y: e.clientY, i: frameAt(e.clientX) };
      return;
    }
    const i = frameAt(e.clientX);
    if (e.shiftKey) setSelection(state.sel, i, false);
    else setSelection(i, i, false);
    dragging = true;
    try { xs.setPointerCapture(e.pointerId); } catch (err) { /* drag works without it */ }
    sc.focus();
    e.preventDefault();
  });
  xs.addEventListener('pointerup', e => {
    if (e.pointerType !== 'touch' || !touchStart) return;
    const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
    if (moved < 12) setSelection(frameAt(e.clientX), frameAt(e.clientX), false);
    touchStart = null;
  });
  xs.addEventListener('pointermove', e => {
    if (!dragging) return;
    // drag past either edge and the sheet scrolls to follow
    const r = xs.getBoundingClientRect();
    if (e.clientX < r.left + 30) sc.scrollLeft -= 14;
    else if (e.clientX > r.right - 30) sc.scrollLeft += 14;
    setSelection(state.sel, frameAt(e.clientX), false);
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    try { xs.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  xs.addEventListener('pointerup', endDrag);
  xs.addEventListener('pointercancel', endDrag);

  sc.addEventListener('keydown', e => {
    if (!state.frames.length) return;
    // A key the sheet answers is the sheet being worked in, whatever was
    // pressed last.
    lastSurface = 'sheet';
    const k = e.key.toUpperCase();
    const mod = e.metaKey || e.ctrlKey;
    // Undo is NOT handled here. It used to be, and the keydown then bubbled to
    // the document-level handler further up this file, which ran it a second
    // time — so one press of ⌘Z with the sheet focused undid two edits. It
    // preventDefault()ed but never stopped propagating, which stops the browser
    // acting on the key and does nothing at all about the page's own listeners.
    // The document handler already covers the sheet, so this one just stays out
    // of its way. Select-all is different: it is a sheet-only idea.
    if (mod && k === 'A') { e.preventDefault(); setSelection(0, state.frames.length - 1, false); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); eraseSelection(); return; }
    if (e.key === 'Escape') { e.preventDefault(); setSelection(state.sel, state.sel, false); return; }
    if (VIS.includes(k)) { e.preventDefault(); setViseme(k); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) setSelection(state.sel, state.selEnd + step, true);
      else { const [a, b] = selRange(); const i = (step > 0 ? b : a) + step; setSelection(i, i, true); }
    }
  });

  $('eraseBtn').onclick = () => { eraseSelection(); sc.focus(); };
  $('undoBtn').onclick = () => { undo(); sc.focus(); };
  $('redoBtn').onclick = () => { redo(); sc.focus(); };

  /* ---- the overview: seek, select, trim, split, drop ----
     One canvas doing several jobs, separated by where you press rather than by
     a mode you have to be in: the two handles trim, a flag in the top lane
     moves or removes a split point, a struck-through stretch comes back, and
     the whole rest of the waveform is the seek-and-select it always was.

     The rule that keeps this honest is that the destructive gestures live in
     small, drawn, deliberate places. Everything else is safe. */
  const tw = $('overview');
  const trimTime = clientX => {
    const sp = ovSpan();
    if (!sp) return 0;
    const r = tw.getBoundingClientRect();
    return ovT(sp, clientX - r.left, r.width);
  };
  tw.addEventListener('pointerdown', e => {
    const sp = ovSpan();
    if (!sp) return;
    const clip = sp.clip;
    const r = tw.getBoundingClientRect();
    const W = r.width, x = e.clientX - r.left, y = e.clientY - r.top;
    const canTrim = !!(clip && clip.srcDuration);

    // A division between two pieces, dragged to retime the cut. Tested before
    // the markers because it is the bigger thing to get wrong.
    if (canTrim && y <= MARK_LANE) {
      const e2 = fileEdges(clip).find(g => Math.abs(ovX(sp, g.t, W) - x) <= EDGE_GRAB_PX);
      if (e2) {
        trimDrag = 'edge';
        edgeDrag = { ...e2, x0: x, moved: false };
        try { tw.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        return;
      }
    }

    // Grab a marker by its flag: drag to move it, release without moving
    // to take it off. Confined to the lane the flags are drawn in, so an
    // ordinary press on the waveform can never destroy one.
    if (canTrim && y <= MARK_LANE) {
      const hit = (clip.marks || []).findIndex(
        m => Math.abs(ovX(sp, m, W) - x) <= MARK_GRAB_PX);
      if (hit >= 0) {
        trimDrag = 'mark';
        markDrag = { i: hit, x0: x, moved: false };
        try { tw.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        return;
      }
    }
    if (canTrim) {
      // Another piece of the same file: open it, standing where it was
      // pressed. This is what makes the timeline a cut list rather than a
      // picture of one clip — and because a piece carries its own puppet and
      // lips, the stage changes character as you move along the file.
      const ts = ovT(sp, x, W);
      const other = fileFamily(clip).find(
        c => c !== clip && ts >= (c.in || 0) && ts <= clipOut(c));
      if (other) {
        openPieceAt(other, ts);
        return;
      }
      // A press inside a dropped stretch brings it back, by the same rule that
      // a press on a marker removes it: press the thing to undo it. It
      // cannot mean "seek here" — there is nothing there to play.
      if (dropAt(clip, ovT(sp, x, W))) {
        undropAt(clip, ovT(sp, x, W));
        applyTrim(clip).then(pushTimeHistory);
        return;
      }
      const xIn = ovX(sp, sp.a, W), xOut = ovX(sp, sp.b, W);
      trimDrag = Math.abs(x - xIn) <= HANDLE_PX ? 'in'
               : Math.abs(x - xOut) <= HANDLE_PX ? 'out' : null;
      if (trimDrag) {
        try { tw.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        drawOverview();
        return;
      }
    }

    // Anywhere else: seek, and put the selection on the frame landed on. Keys
    // snap, because landing one frame off one and editing a different one
    // silently would be worse than not snapping at all.
    if (!state.buffer) return;
    trimDrag = 'scrub';
    // A capture that cannot be taken is not a reason to drop the seek.
    try { tw.setPointerCapture(e.pointerId); } catch (err) {}
    const t = clamp(ovT(sp, x, W) - sp.a, 0, Math.max(0, sp.b - sp.a - 0.001));
    seekTo(t);
    const i = clamp(Math.floor(t * state.fps), 0, Math.max(0, state.frames.length - 1));
    state.sel = state.selEnd = i;
    updateSelReadout();
      drawSheet(); drawStage(); drawOverview();
  });
  tw.addEventListener('pointermove', e => {
    if (!trimDrag) {
      // Say what is under the pointer, so the flag lane is findable without
      // having to be told about it.
      const sp0 = ovSpan();
      if (!sp0 || !sp0.clip) return;
      const r0 = tw.getBoundingClientRect();
      const xx = e.clientX - r0.left, yy = e.clientY - r0.top;
      const onEdge = yy <= MARK_LANE && fileEdges(sp0.clip)
        .some(g => Math.abs(ovX(sp0, g.t, r0.width) - xx) <= EDGE_GRAB_PX);
      const onFlag = yy <= MARK_LANE && (sp0.clip.marks || [])
        .some(m => Math.abs(ovX(sp0, m, r0.width) - xx) <= MARK_GRAB_PX);
      const onHandle = Math.abs(xx - ovX(sp0, sp0.a, r0.width)) <= HANDLE_PX ||
                       Math.abs(xx - ovX(sp0, sp0.b, r0.width)) <= HANDLE_PX;
      tw.style.cursor = onEdge ? 'col-resize' : onFlag ? 'grab'
                      : onHandle ? 'ew-resize' : 'pointer';
      return;
    }
    const sp = ovSpan();
    if (!sp) return;
    const clip = sp.clip;
    const t = trimTime(e.clientX);
    if (trimDrag === 'scrub') {
      seekTo(clamp(t - sp.a, 0, Math.max(0, sp.b - sp.a - 0.001)));
      drawOverview();
      return;
    }
    if (trimDrag === 'edge') {
      const r3 = tw.getBoundingClientRect();
      if (Math.abs(e.clientX - r3.left - edgeDrag.x0) > 3) edgeDrag.moved = true;
      if (edgeDrag.moved) {
        // Half a second of each piece is the floor, the same floor a trim
        // handle has: below that there is no clip left either side of the cut.
        const lo = (edgeDrag.left.in || 0) + 0.5;
        const hi = clipOut(edgeDrag.right) - 0.5;
        if (hi > lo) {
          const v = +clamp(t, lo, hi).toFixed(4);
          edgeDrag.left.out = v;
          edgeDrag.right.in = v;
          edgeDrag.t = v;
          trimReadout(); drawOverview();
        }
      }
      return;
    }
    if (trimDrag === 'mark') {
      const r2 = tw.getBoundingClientRect();
      if (Math.abs(e.clientX - r2.left - markDrag.x0) > 3) markDrag.moved = true;
      if (markDrag.moved) {
        // Inside the clip, and not on top of a neighbour: two split points at
        // the same place would make a zero-length piece.
        const lo = (clip.in || 0) + 0.15;
        const hi = (clip.out == null ? clip.srcDuration : clip.out) - 0.15;
        const others = clip.marks.filter((m, k) => k !== markDrag.i);
        let v = clamp(t, lo, hi);
        if (others.some(m => Math.abs(m - v) < 0.12)) return;
        clip.marks[markDrag.i] = +v.toFixed(4);
        trimReadout(); drawOverview();
      }
      return;
    }
    // Half a second is the floor: below that there is no clip left to work on.
    if (trimDrag === 'in') clip.in = Math.min(t, (clip.out == null ? clip.srcDuration : clip.out) - 0.5);
    else clip.out = Math.max(t, (clip.in || 0) + 0.5);
    trimReadout(); drawOverview();
  });
  const endTrim = async e => {
    if (!trimDrag) return;
    const was = trimDrag;
    trimDrag = null;
    try { tw.releasePointerCapture(e.pointerId); } catch (err) {}
    if (was === 'edge') {
      const d = edgeDrag;
      edgeDrag = null;
      if (!d || !d.moved) { drawOverview(); return; }
      // Both pieces changed length. The open one is re-cut and re-analysed
      // here and now; the other is marked as needing it, and pays when it is
      // next opened — which is also when anyone can see the difference.
      const open = activeClip();
      staleClip(d.left === open ? d.right : d.left);
      if (d.left === open || d.right === open) await applyTrim(open);
      else { staleClip(d.left); staleClip(d.right); }
      renderQueue();
      updateBatchUI();
      trimReadout(); drawOverview();
      pushTimeHistory();
      toast('Cut moved to ' + fmtTime(d.t) + '.', 2000);
      return;
    }
    if (was === 'mark') {
      // Grabbed a flag and let go without moving it: that is the gesture for
      // taking the marker off. Moving one only moves a bookmark, so neither
      // needs the audio touching.
      const clip = activeClip();
      if (clip && !markDrag.moved) clip.marks.splice(markDrag.i, 1);
      else if (clip) clip.marks.sort((a, b) => a - b);
      markDrag = null;
      trimReadout(); drawOverview();
      pushTimeHistory();
      return;
    }
    // Only a handle move needs the audio cutting again; scrubbing does not.
    if (was !== 'scrub') { await applyTrim(activeClip()); pushTimeHistory(); }
  };
  tw.addEventListener('pointerup', endTrim);
  tw.addEventListener('pointercancel', endTrim);

  $('trimMark').onclick = () => markAtPlayhead();
  $('trimSplit').onclick = () => splitAtPlayhead();
  $('timeUndo').onclick = () => timeUndo();
  $('timeRedo').onclick = () => timeRedo();
  $('styleToAll').onclick = () => {
    const n = spreadLips(1);
    toast(n ? 'Gave those lips to ' + n + ' other clip' + (n === 1 ? '' : 's') + '.'
            : 'There is nothing else in the queue.', 3000);
  };
  $('styleToEvery2').onclick = () => {
    const n = spreadLips(2);
    toast(n ? 'Gave those lips to ' + n + ' clip' + (n === 1 ? '' : 's') +
              ' — every second one from here. The clips in between keep theirs.'
            : 'There is no second clip from here to give them to.', 4500);
  };

  $('trimDrop').onclick = async () => {
    const clip = activeClip();
    if (!clip) return;
    const seg = segmentAt(clip, clipToSrc(clip, playTime()));
    if (!seg) return;
    if (segmentsKept(clip) <= 1) {
      toast('That is the only bit left. Put a split point in first, or trim the ends.', 4000);
      return;
    }
    clip.drops = [...(clip.drops || []), [seg[0], seg[1]]].sort((a, b) => a[0] - b[0]);
    await applyTrim(clip);
    toast('Dropped ' + fmtTime(seg[1] - seg[0]) + '. Press the struck-through stretch to bring it back.', 4000);
  };
  $('trimAuto').onclick = () => {
    const clip = activeClip();
    if (!clip || !state.frames.length) return;
    const cuts = silenceCuts(0.35);
    let n = 0;
    cuts.forEach(t => { if (addMark(clip, t)) n++; });
    trimReadout(); drawTrim();
    if (n) pushTimeHistory();
    toast(n ? 'Put ' + n + ' marker' + (n === 1 ? '' : 's') + ' in the pauses. Move or remove any, then split at them.'
            : 'No pauses long enough to cut on.', 4000);
  };
  $('trimClear').onclick = () => {
    const clip = activeClip();
    if (!clip || !(clip.marks || []).length) return;
    clip.marks = [];
    trimReadout(); drawTrim();
    pushTimeHistory();
  };
  $('trimCommit').onclick = () => {
    const clip = activeClip();
    if (!clip || !clip.marks || !clip.marks.length) return;
    const cuts = clip.marks.slice();
    clip.marks = [];
    if (splitClipAt(clip, cuts)) pushTimeHistory();
    else toast('Those markers were too close to the ends.', 3000);
  };
  $('trimReset').onclick = async () => {
    const clip = activeClip();
    if (!clip) return;
    const n = await unsplitFile(clip);
    if (n > 1) toast('Put back together — ' + n + ' pieces are one clip again.', 3500);
  };
  $('trimDelete').onclick = () => {
    const clip = activeClip();
    if (clip) removeClip(clip.id);
  };

  document.addEventListener('keydown', e => {
    // The sheet answers X A B C D E F G H itself, and B is both a mouth shape
    // and the blade. The sheet's own handler runs first and preventDefaults
    // what it took, so the test here is simply "has anyone answered already" —
    // with the sheet focused B retimes a run, and everywhere else it cuts.
    if (e.defaultPrevented) return;
    if (e.target.matches('input,select,textarea,button')) return;
    const k = (e.key || '').toUpperCase();
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Home') { e.preventDefault(); jumpTo('start'); }
    else if (e.key === 'End') { e.preventDefault(); jumpTo('end'); }
    else if (!mod && k === 'M') { e.preventDefault(); markAtPlayhead(); }
    else if (!mod && k === 'B') { e.preventDefault(); splitAtPlayhead(); }
  });

  initLipSets();

  $('outSize').onchange = updateEstimates;
  // Called with no argument on purpose: the runners take an optional batch sink
  // as their first parameter, and a DOM handler would hand them the click event.
  Object.keys(EXPORT_CARDS).forEach(key => {
    const b = $(EXPORT_CARDS[key].btn);
    if (b) b.onclick = () => runExport(key);
  });
  $('fcpSize').onchange = updateEstimates;
  $('ovFps').onchange = updateEstimates;
  $('ovSize').onchange = updateEstimates;
  $('keyAudio').onchange = updateEstimates;
  $('keyColor').oninput = () => {
    document.querySelectorAll('.swatch').forEach(s =>
      s.classList.toggle('on', s.dataset.key.toLowerCase() === $('keyColor').value.toLowerCase()));
  };
  $('swatches').innerHTML = KEY_PRESETS.map(([hex, name]) =>
    '<button type="button" class="swatch' + (hex === '#00B140' ? ' on' : '') +
    '" data-key="' + hex + '" title="' + name + '" style="background:' + hex + '"></button>').join('');
  $('swatches').onclick = e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    $('keyColor').value = b.dataset.key;
    $('keyColor').dispatchEvent(new Event('input'));
  };

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { sizeSheetPane(); layoutSheet(); drawSheet(); drawOverview(); }, 120);
  });
  // The column changes width on its own too — a tab with a wider panel opens,
  // a scrollbar appears — and neither is a window resize. The sheet's two
  // canvases have to be re-measured when it happens or they paint at the old
  // width and come back a sliver.
  if (typeof ResizeObserver !== 'undefined') {
    const sp = document.querySelector('.sheetwrap');
    if (sp) new ResizeObserver(() => { layoutSheet(); drawSheet(); drawOverview(); }).observe(sp);
  }
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => {
    // Still following the system: the toggle's icon has to move with it too.
    if (themeChoice === 'auto') { syncThemeToggle(); repaintTheme(); }
  });
}

/* Hosted builds get file saving through the host; a local copy just downloads. */
function detectDelivery() {
  const chip = $('modeChip'), txt = $('modeTxt');
  if (typeof window.claude === 'undefined' || !window.claude.use) {
    txt.textContent = 'Local file · zip exports';
    return;
  }
  txt.textContent = 'Hosted page';
  window.claude.use('downloads').then(api => {
    if (!api) {
      chip.classList.add('warn');
      txt.textContent = 'Saving unavailable here';
      ['expChart', 'expSeq', 'expSprite'].forEach(id => $(id).disabled = true);
      return;
    }
    download.mode = 'artifact';
    download.api = api;
    txt.textContent = 'Hosted page · single files';
    $('expSeq').disabled = true;
    $('expFcp').disabled = true;
    $('expFcp').textContent = 'Needs the downloadable copy';
    $('expFcp').title = 'A Final Cut project is a folder of files, which a hosted page cannot hand over. Use the standalone HTML version for this one.';
    $('estFcp').textContent = 'zip unavailable on a hosted page';
    $('expSeq').textContent = 'Needs the downloadable copy';
    $('expSeq').title = 'A frame sequence has to arrive as a zip, which a hosted page cannot hand over. Use the standalone HTML version for this one.';
    $('estSeq').textContent = 'zip unavailable on a hosted page';
    $('expChart').textContent = 'Export chart sheet + timing';
    setExportsEnabled(!!state.frames.length);
  }).catch(() => {});
}

/* ------------------------------------------------------------------- boot */

function boot() {
  const vEl = $('appVersion');
  if (vEl) vEl.textContent = 'v' + APP_VERSION;
  initTheme();
  wireTabs();
  wireExpInfo();
  buildFacePick();
  syncLayers();
  wireCanvasControls();
  wireBoilControls();
  $('demoBtn').onclick = loadDemo;
  syncDemoBtn();
  buildStyleChips();
  buildChart();
  buildLegend();
  syncEngineUI();
  sizeStage();
  updateOverlayReadout();
  resetHistory();
  updateSelReadout();
  layoutSheet();
  drawSheet();
  drawOverview();
  drawStage();
  wire();
  detectDelivery();
  setExportsEnabled(false);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

