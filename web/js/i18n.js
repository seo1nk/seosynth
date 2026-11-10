// All user-facing text, Japanese and English.
// Entries are [ja, en]. Parameter texts are [label, help].

export const LANGS = ['ja', 'en'];

const UI = {
  'app.tagline': ['ブラウザで動くウェーブテーブルシンセ', 'A wavetable synth in your browser'],
  'audio.start': ['クリックまたはキーを押すと音が出ます', 'Click or press a key to start audio'],
  'audio.error': ['オーディオを開始できませんでした', 'Could not start audio'],

  'lane.flow': ['音の流れ', 'Signal flow'],
  'lane.flow.hint': ['左から右へ音が流れます。各モジュールの右端の小さな波形が「そこから出ていく音」です。', 'Sound flows left to right. The small waveform at the right edge of each module is the sound leaving it.'],
  'lane.mod': ['動かす（モジュレーション）', 'Modulation'],
  'lane.mod.hint': ['ここにあるのは音ではなく「つまみを動かす信号」です。色付きの ● をつまみへドラッグするとつながります。', 'These make no sound: they move knobs. Drag a coloured ● onto any knob to connect it.'],

  'mod.sources': ['音のもと', 'Sources'],
  'mod.oscA': ['OSC A', 'OSC A'],
  'mod.oscB': ['OSC B', 'OSC B'],
  'mod.sub': ['SUB', 'SUB'],
  'mod.noise': ['NOISE', 'NOISE'],
  'mod.filter': ['フィルター', 'FILTER'],
  'mod.amp': ['アンプ', 'AMP'],
  'mod.fx': ['エフェクト', 'EFFECTS'],
  'mod.out': ['出力', 'OUTPUT'],
  'mod.env': ['ENV', 'ENV'],
  'mod.lfo': ['LFO', 'LFO'],
  'mod.macro': ['マクロ', 'MACROS'],
  'mod.perf': ['演奏', 'PLAYING'],
  'mod.voice': ['ボイス', 'VOICE'],

  'role.oscA': ['波形をくり返して音を出す', 'Repeats a waveform to make a tone'],
  'role.oscB': ['2つ目の音。重ねて厚みや変化を', 'A second tone to layer'],
  'role.sub': ['低音を支えるシンプルな波', 'A simple wave for low-end weight'],
  'role.noise': ['ザラつきや空気感を足す', 'Adds breath and grit'],
  'role.filter': ['音を削って明るさを変える', 'Carves the tone: bright or dark'],
  'role.amp': ['音量の時間変化をつくる', 'Shapes loudness over time'],
  'role.fx': ['響き・厚み・歪みを足す', 'Adds space, width and dirt'],
  'role.out': ['最終的に聞こえる音', 'What you finally hear'],
  'role.env': ['弾くたびに一度だけ動く', 'Runs once per note'],
  'role.lfo': ['くり返し揺れ続ける', 'Keeps cycling'],
  'role.macro': ['複数をまとめて動かす', 'One knob for many'],
  'role.perf': ['弾き方に応じて変わる', 'Follows how you play'],

  'about.oscA': [
    'オシレーターは音の出発点です。「ウェーブテーブル」は少しずつ形の違う波形を束ねたもので、WT位置を動かすと音色がなめらかに変わります。出力はフィルターへ進みます。',
    'An oscillator is where the sound starts. A wavetable is a stack of slightly different waveforms; moving WT POS morphs the tone. Its output goes on to the filter.',
  ],
  'about.sub': [
    'サブオシレーターは、メインの音の下で鳴るシンプルな波形です。オクターブを下げて、低音の土台を足すのによく使います。',
    'The sub oscillator plays a simple waveform underneath the main tone, usually an octave or two down, for a solid low end.',
  ],
  'about.noise': [
    'ノイズは音程のない「ザー」という音です。アタックの息づかいや、きらめき・風のような質感を足せます。',
    'Noise has no pitch. Use it for breathy attacks, shimmer or wind-like texture.',
  ],
  'about.filter': [
    'フィルターは入ってきた音の一部の帯域を削ります。ローパス（LP）はカットオフより上を削るので、下げるほど音がこもり、上げるほど明るくなります。エンベロープやLFOでカットオフを動かすのがシンセの定番です。',
    'A filter removes part of the spectrum. A low-pass (LP) removes everything above the cutoff: lower is darker, higher is brighter. Moving the cutoff with an envelope or LFO is the classic synth sound.',
  ],
  'about.amp': [
    'アンプは音量を決めます。ENV 1 が音量の時間変化（立ち上がり・減衰・余韻）を担当します。アタックを長くすればふわっと、リリースを長くすれば余韻が残ります。',
    'The amplifier sets loudness. ENV 1 shapes it over time: a long attack fades in softly, a long release leaves a tail.',
  ],
  'about.fx': [
    'エフェクトは上から順に音を加工します。行をドラッグすると順番を入れ替えられます（例：歪み→リバーブ と リバーブ→歪み は違う音になります）。',
    'Effects process the sound from top to bottom. Drag a row to change the order: distortion into reverb sounds different from reverb into distortion.',
  ],
  'about.out': [
    '最終的な音量と、いま出ている音の波形・周波数成分（スペクトラム）を表示します。メーターが赤くなる場合は音量を下げましょう。',
    'Final volume, plus the waveform and spectrum of what you hear. If the meter turns red, turn the volume down.',
  ],
  'about.env': [
    'エンベロープは、鍵盤を押すたびに「上がって→下がって→保って→消える」という動きを一度だけ出します。●をつまみにドラッグすると、その動きでつまみを動かせます（例：フィルターのカットオフ）。',
    'An envelope produces one rise-and-fall shape each time you press a key. Drag its ● onto a knob to move that knob with this shape (the filter cutoff, for example).',
  ],
  'about.lfo': [
    'LFOはゆっくりくり返す波で、つまみを周期的に揺らします。音量につなげばトレモロ、音程ならビブラート、カットオフならワウのような効果に。形は自由に描くこともできます。',
    'An LFO is a slow repeating wave that wobbles a knob: tremolo on level, vibrato on pitch, a wah on cutoff. You can also draw your own shape.',
  ],
  'about.macro': [
    'マクロは自由に割り当てられるつまみです。1つのマクロを複数のつまみにつなぐと、ひとひねりで音色を大きく変えられます。',
    'Macros are free knobs. Connect one macro to several parameters to change the whole sound with a single twist.',
  ],
  'about.perf': [
    '弾く強さ（ベロシティ）や音の高さ（ノート）なども、つまみを動かす信号として使えます。',
    'How hard you play (velocity), which note you play and more can also drive knobs.',
  ],

  'port.toFilter': ['フィルターへ', 'To filter'],
  'port.bypass': ['迂回', 'Bypass'],
  'port.route.help': [
    'この音をフィルターに通すか、迂回させるかを切り替えます。',
    'Choose whether this source goes through the filter or around it.',
  ],
  'cable.bypass': ['迂回ルート', 'Bypass path'],

  'btn.more': ['詳細', 'More'],
  'btn.less': ['閉じる', 'Less'],
  'btn.init': ['新規', 'Init'],
  'btn.undo': ['元に戻す', 'Undo'],
  'btn.redo': ['やり直す', 'Redo'],
  'btn.share': ['共有', 'Share'],
  'btn.file': ['ファイル', 'File'],
  'btn.help': ['ガイド', 'Guide'],
  'btn.matrix': ['配線一覧', 'Routings'],
  'btn.cables': ['配線を表示', 'Show wires'],
  'btn.demo': ['デモ演奏', 'Demo'],
  'btn.hold': ['ホールド', 'Hold'],
  'btn.panic': ['音を止める', 'Stop sound'],
  'btn.close': ['閉じる', 'Close'],
  'btn.copy': ['コピー', 'Copy'],
  'btn.copied': ['コピーしました', 'Copied'],
  'btn.random': ['ランダム', 'Random'],
  'btn.prev': ['前のプリセット', 'Previous preset'],
  'btn.next': ['次のプリセット', 'Next preset'],

  'file.exportJson': ['プリセットを保存（.json）', 'Save preset (.json)'],
  'file.importJson': ['プリセットを開く…', 'Open preset…'],
  'file.exportSerum': ['Serum 2 用に書き出す（.SerumPreset）', 'Export for Serum 2 (.SerumPreset)'],
  'file.imported': ['プリセットを読み込みました', 'Preset loaded'],
  'file.importFailed': ['読み込めませんでした（対応していないファイルです）', 'Could not open this file'],
  'file.exported': ['書き出しました', 'Exported'],

  'share.title': ['この音色を共有', 'Share this sound'],
  'share.body': [
    'このURLを開くと、いまの設定がそのまま再現されます。設定はURLの中に入っているので、サーバーには何も保存されません。',
    'Opening this link restores the sound exactly as it is now. The settings live inside the link itself; nothing is stored on a server.',
  ],
  'share.name': ['音色の名前', 'Sound name'],
  'share.loaded': ['共有された音色を読み込みました', 'Loaded the shared sound'],
  'share.invalid': ['URLの音色データを読み取れませんでした', 'The sound in this link could not be read'],
  'share.native': ['共有…', 'Share…'],

  'preset.title': ['プリセット', 'Presets'],
  'preset.all': ['すべて', 'All'],
  'preset.user': ['（編集済み）', '(edited)'],
  'cat.init': ['基本', 'Basics'],
  'cat.bass': ['ベース', 'Bass'],
  'cat.lead': ['リード', 'Lead'],
  'cat.pad': ['パッド', 'Pad'],
  'cat.pluck': ['プラック', 'Pluck'],
  'cat.keys': ['キー', 'Keys'],
  'cat.fx': ['効果音', 'FX'],
  'cat.learn': ['学ぶ', 'Learn'],

  'matrix.title': ['モジュレーション配線', 'Modulation routings'],
  'matrix.empty': [
    'まだ配線がありません。下の段の ● をつまみにドラッグしてみましょう。',
    'No routings yet. Drag a ● from the modulation row onto a knob.',
  ],
  'matrix.moves': ['→', '→'],
  'matrix.amount': ['量', 'Amount'],
  'matrix.bipolar': ['両方向', 'Both ways'],
  'matrix.bipolar.help': [
    'オフ：つまみの位置から一方向に動かす。オン：つまみの位置を中心に上下に動かす。',
    'Off: moves one way from the knob position. On: swings both ways around it.',
  ],
  'matrix.remove': ['配線を外す', 'Remove routing'],
  'matrix.full': ['配線の数が上限に達しました', 'All routing slots are in use'],

  'modhint.drag': ['つまみの上で離すとつながります', 'Drop on a knob to connect'],
  'modhint.connected': ['{src} → {dst} をつなぎました', 'Connected {src} → {dst}'],
  'modhint.removed': ['配線を外しました', 'Routing removed'],
  'modhint.assign': ['つなぎ先のつまみをクリック（Escで中止）', 'Click the knob to connect (Esc to cancel)'],

  'menu.reset': ['初期値に戻す', 'Reset to default'],
  'menu.mods': ['このつまみを動かしているもの', 'What moves this knob'],
  'menu.addMod': ['動かすものを追加', 'Add a modulator'],
  'menu.enter': ['数値を入力…', 'Enter value…'],
  'menu.enter.prompt': ['新しい値', 'New value'],

  'kb.octave': ['オクターブ', 'Octave'],
  'kb.hint': [
    'PCのキーボードでも弾けます： Z X C V… が下の段、 Q W E R… が上の段',
    'Play with your computer keyboard too: Z X C V… lower row, Q W E R… upper row',
  ],
  'kb.midi': ['MIDI', 'MIDI'],
  'kb.midi.on': ['MIDIキーボード接続中', 'MIDI keyboard connected'],
  'kb.midi.none': ['MIDI機器が見つかりません', 'No MIDI device found'],
  'kb.midi.denied': ['MIDIを使用できません', 'MIDI is not available'],
  'kb.velocity': ['キーの下のほうを押すほど強く弾けます', 'Press lower on a key to play harder'],

  'out.voices': ['発音数', 'Voices'],
  'out.scope': ['波形', 'Wave'],
  'out.spectrum': ['スペクトラム', 'Spectrum'],

  'hint.default': [
    'つまみにマウスを乗せると説明が出ます。ドラッグで調整、ダブルクリックで初期値、Shift で微調整。',
    'Hover any control for an explanation. Drag to adjust, double-click to reset, hold Shift for fine steps.',
  ],
  'hint.wt': ['上下にドラッグするとWT位置が動きます', 'Drag up or down to move through the wavetable'],
  'hint.filterDisplay': [
    '点をドラッグ：左右でカットオフ、上下でレゾナンス。曲線は「どの高さの音をどれだけ通すか」。',
    'Drag the dot: left/right is cutoff, up/down is resonance. The curve shows how much of each pitch gets through.',
  ],
  'hint.envDisplay': [
    '点をドラッグして形を変えられます。光る点は、いま鳴っている音がどこにいるかを示します。',
    'Drag the points to reshape. The glowing dot shows where the sounding note currently is.',
  ],
  'hint.lfoDisplay': [
    '「Custom」を選ぶと形を描けます：ドラッグで移動、ダブルクリックで点の追加・削除、線の中ほどをドラッグでカーブ。',
    'Choose "Custom" to draw: drag points, double-click to add or remove one, drag the middle of a line to bend it.',
  ],
  'hint.modSource': [
    'この ● をつまみへドラッグすると、{name} がそのつまみを動かします。クリックして、つなぎ先をクリックでもOK。',
    'Drag this ● onto a knob and {name} will move it. Or click it, then click the knob.',
  ],
  'hint.modAmount': [
    'ドラッグで動かす量を調整（下げきるとマイナス方向）。ダブルクリックで配線を外します。',
    'Drag to set how far it moves the knob (below zero inverts). Double-click to remove.',
  ],
  'hint.fxDrag': ['ドラッグして順番を入れ替え', 'Drag to reorder'],
  'hint.scope': ['{name} から出ていく音の波形', 'The waveform leaving {name}'],
  'hint.cable': ['音の通り道。明るく光るほど大きな音が流れています。', 'An audio path. Brighter means louder.'],

  'tour.title': ['はじめてガイド', 'First steps'],
  'tour.skip': ['ガイドを終える', 'End guide'],
  'tour.next': ['次へ', 'Next'],
  'tour.back': ['戻る', 'Back'],
  'tour.done': ['完了', 'Done'],
  'tour.step': ['ステップ {n} / {total}', 'Step {n} of {total}'],
  'tour.1.title': ['まず音を出してみよう', 'Make a sound'],
  'tour.1.body': [
    '画面下の鍵盤をクリックするか、PCのキーボードの Z X C V… を押してみてください。',
    'Click the keyboard at the bottom, or press Z X C V… on your computer keyboard.',
  ],
  'tour.2.title': ['音の流れを見る', 'Follow the signal'],
  'tour.2.body': [
    '音は左から右へ流れます： 音のもと → フィルター → アンプ → エフェクト → 出力。線が光っているところを音が通っています。',
    'Sound flows left to right: sources → filter → amp → effects → output. Glowing lines carry sound.',
  ],
  'tour.3.title': ['音色のもとを変える', 'Change the raw tone'],
  'tour.3.body': [
    'OSC A の「WT位置」を回すか、波形の表示を上下にドラッグしてみましょう。波形の形が変わると音色も変わります。',
    'Turn WT POS on OSC A, or drag up and down on the waveform display. A different shape is a different tone.',
  ],
  'tour.4.title': ['フィルターで削る', 'Carve with the filter'],
  'tour.4.body': [
    'フィルターの「カットオフ」を下げると、高い成分が削られて音がこもります。「レゾナンス」を上げるとクセが出ます。',
    'Lower the filter CUTOFF to remove the highs and darken the sound. Raise RES for a sharper character.',
  ],
  'tour.5.title': ['音量の形をつくる', 'Shape the loudness'],
  'tour.5.body': [
    'アンプの ENV 1 で、音の立ち上がり（アタック）や余韻（リリース）を変えられます。グラフの点をドラッグしてみましょう。',
    'ENV 1 in the amp sets how the note starts (attack) and fades (release). Try dragging the points on the graph.',
  ],
  'tour.6.title': ['つまみを自動で動かす', 'Make a knob move by itself'],
  'tour.6.body': [
    'LFO 1 の ● を、フィルターの「カットオフ」のつまみへドラッグしてください。音が周期的に揺れ始めます。',
    'Drag the ● of LFO 1 onto the filter CUTOFF knob. The sound starts to wobble in time.',
  ],
  'tour.7.title': ['エフェクトを足す', 'Add an effect'],
  'tour.7.body': [
    'エフェクトの中から「リバーブ」や「ディレイ」の電源ボタンを押してみましょう。響きが加わります。',
    'Switch on REVERB or DELAY in the effects rack to add space.',
  ],
  'tour.8.title': ['できた音を共有', 'Share what you made'],
  'tour.8.body': [
    '右上の「共有」を押すと、この音色を再現できるURLが作れます。プリセットからいろいろな音も試してみてください。',
    'Press Share in the top right to get a link that recreates this exact sound. Try the presets for more ideas.',
  ],

  'serum.title': ['Serum 2 用に書き出す', 'Export for Serum 2'],
  'serum.intro': [
    'いまの音色を Serum 2 のプリセット（.SerumPreset）に変換します。Nami と Serum は別のシンセなので、同じ音にはなりません。つまみの位置・配線・エフェクトの並びを、できる範囲で移し替えます。',
    'Converts the current sound into a Serum 2 preset (.SerumPreset). Nami and Serum are different synths, so it will not sound identical: knob positions, routings and the effect order are carried over as far as they can be.',
  ],
  'serum.caveat': [
    '.SerumPreset は公開されていない形式で、コミュニティの解析結果をもとに書き出しています。Serum 2 本体での読み込みはまだ確認できていません。読み込めない・おかしい場合はご報告ください。',
    'The .SerumPreset format is not published; this export follows what the community has worked out, and loading it in Serum 2 itself has not been verified yet. Please report it if a file does not load.',
  ],
  'serum.step1': ['1. プリセット', '1. The preset'],
  'serum.step2': ['2. ウェーブテーブル', '2. The wavetables'],
  'serum.tables.help': [
    'Serum はウェーブテーブルを自分のフォルダから読み込みます。下の WAV を「Serum 2 Presets」フォルダの中の Tables / Nami フォルダ（なければ作成）に入れてください。',
    'Serum loads wavetables from its own folder. Put the WAV files below into Tables / Nami inside your "Serum 2 Presets" folder (create the Nami folder if needed).',
  ],
  'serum.tables.none': ['このプリセットはウェーブテーブルを使いません。', 'This preset uses no wavetables.'],
  'serum.zip': ['まとめてダウンロード（.zip）', 'Download everything (.zip)'],
  'serum.preset': ['プリセットをダウンロード', 'Download preset'],
  'serum.notes': ['変換メモ', 'Conversion notes'],
  'serum.notes.none': ['すべての設定を移し替えました。', 'Every setting was carried over.'],
  'serum.note.tables': [
    'ウェーブテーブルは別ファイルです。上の手順 2 のとおり Serum 側に置いてください。',
    'Wavetables are separate files: install them as described in step 2.',
  ],
  'serum.note.noise': [
    'ノイズ（{detail}）は Serum の内蔵ノイズサンプルで代用しています。Serum 側で近いノイズを選び直してください。',
    'The noise ({detail}) is replaced by one of Serum\'s stock noise samples. Pick the closest one in Serum.',
  ],
  'serum.note.filterType': [
    '{detail} は、相当しそうな Serum のフィルターを推定で指定しています。',
    '{detail}: the closest Serum filter type was guessed.',
  ],
  'serum.note.warpApprox': ['{detail} は Serum の近いワープで代用しています。', '{detail} is approximated by the nearest Serum warp.'],
  'serum.note.warpDropped': ['{detail} のワープは移し替えていません。', '{detail}: this warp mode was not carried over.'],
  'serum.note.modDropped': [
    '配線「{detail}」は Serum 側の行き先が特定できず、移し替えていません。',
    'Routing "{detail}" was not carried over: its Serum destination is unknown.',
  ],
  'serum.note.lfoRandom': [
    '{detail} のランダム波形は、固定のパターンに置き換えています。',
    '{detail}: the random shape became a fixed pattern.',
  ],
  'serum.note.lfoSmooth': ['{detail} のスムーズは移し替えていません。', '{detail}: smoothing was not carried over.'],
  'serum.note.portamento': [
    'グライドは時間だけを移し替えています（常にグライドの設定は Serum 側で確認してください）。',
    'Glide: only the time was carried over; check the "always" setting in Serum.',
  ],
  'serum.note.bendRange': ['ベンド幅は上方向だけを設定しています。', 'Bend range: only the upward range was set.'],
  'serum.note.masterPitch': ['全体のピッチは移し替えていません。', 'The global pitch offset was not carried over.'],
  'serum.note.distApprox': ['ディストーションの {detail} は Downsample で代用しています。', 'Distortion {detail} is approximated by Downsample.'],
  'serum.note.delayLong': ['8小節のディレイは Serum の最長（4小節）にしています。', 'An 8-bar delay was shortened to Serum\'s longest (4 bars).'],
  'serum.note.reverbDecay': [
    'Plate リバーブの長さは Serum ではサイズで決まるため、「長さ」は移し替えていません。',
    'Plate reverb: Serum sets its length by size, so DECAY was not carried over.',
  ],
  'serum.readme': [
    'Nami から書き出した Serum 2 用プリセットです。\n\n1. .SerumPreset ファイルを Serum 2 のプリセットフォルダ（Serum 2 Presets/Presets/User など）に入れるか、Serum 2 のメニューから読み込みます。\n2. Tables/Nami フォルダの中の WAV を、Serum 2 Presets/Tables/Nami に入れます（Nami フォルダがなければ作成）。\n\nNami と Serum は別のシンセなので、同じ音にはなりません。',
    'A Serum 2 preset exported from Nami.\n\n1. Put the .SerumPreset file into your Serum 2 preset folder (for example Serum 2 Presets/Presets/User), or load it from Serum 2\'s menu.\n2. Copy the WAV files in Tables/Nami into Serum 2 Presets/Tables/Nami (create the Nami folder if needed).\n\nNami and Serum are different synths, so the result will not sound identical.',
  ],
  'toast.patchInit': ['初期状態に戻しました', 'Reset to the initial sound'],
  'lang.switch': ['English', '日本語'],
};

// [label, help] per parameter; keys are generic (osc / env / lfo / macro).
const PARAM = {
  'master.volume': [['音量', 'VOLUME'], ['最終的な音の大きさ。', 'Final output level.']],
  'master.pitch': [['ピッチ', 'PITCH'], ['全体の音の高さ（半音単位）。LFOをつなぐとビブラートになります。', 'Overall pitch in semitones. Connect an LFO for vibrato.']],
  'master.voices': [['同時発音数', 'VOICES'], ['同時に鳴らせる音の数。少なくすると処理が軽くなります。', 'How many notes can sound at once. Fewer is lighter on the CPU.']],
  'master.mono': [['モノ', 'MONO'], ['一度に1音だけ鳴らします。ベースやリードに向いています。', 'One note at a time. Good for bass and lead lines.']],
  'master.legato': [['レガート', 'LEGATO'], ['前の音を離さずに次を弾くと、音を切らずになめらかにつなぎます（モノのとき有効）。', 'When notes overlap, glide into the next one without restarting it (mono mode).']],
  'master.porta': [['グライド', 'GLIDE'], ['音程が次の音へすべるように移る時間。', 'Time for the pitch to slide to the next note.']],
  'master.portaAlways': [['常にグライド', 'ALWAYS'], ['オン：いつもグライド。オフ：音を重ねて弾いたときだけ。', 'On: always glide. Off: only when notes overlap.']],
  'master.bendRange': [['ベンド幅', 'BEND'], ['ピッチベンドで動く音程の幅。', 'How far the pitch wheel bends.']],
  'master.bpm': [['テンポ', 'TEMPO'], ['テンポ（BPM）。同期したLFOやディレイ、デモ演奏の速さに使われます。', 'Tempo in BPM, used by synced LFOs, the delay and the demo player.']],
  'master.velSens': [['ベロシティ', 'VELOCITY'], ['鍵盤を弾く強さが音量に影響する度合い。0%で常に同じ音量。', 'How much playing harder makes it louder. 0% means always the same.']],
  macro: [['マクロ', 'MACRO'], ['自由に使えるつまみ。●を他のつまみへドラッグしてつなぎます。', 'A free knob. Drag its ● onto other knobs to control them.']],

  'osc.on': [['電源', 'ON'], ['このオシレーターを鳴らすかどうか。', 'Switch this oscillator on or off.']],
  'osc.wt': [['ウェーブテーブル', 'WAVETABLE'], ['波形の束（ウェーブテーブル）を選びます。音色の方向性がここで決まります。', 'Pick the wavetable: a stack of waveforms. This sets the basic character.']],
  'osc.pos': [['WT位置', 'WT POS'], ['ウェーブテーブルの中のどの波形を鳴らすか。動かすと音色がなめらかに変わります。LFOやENVをつなぐのが定番。', 'Which waveform of the table plays. Moving it morphs the tone; a favourite target for LFOs and envelopes.']],
  'osc.level': [['レベル', 'LEVEL'], ['このオシレーターの音量。', 'Volume of this oscillator.']],
  'osc.pan': [['パン', 'PAN'], ['左右の位置。', 'Left / right position.']],
  'osc.oct': [['オクターブ', 'OCTAVE'], ['音の高さをオクターブ単位で上下します。', 'Shifts the pitch by octaves.']],
  'osc.semi': [['セミトーン', 'SEMI'], ['音の高さを半音単位で上下します。+7で5度上。', 'Shifts the pitch by semitones. +7 is a fifth up.']],
  'osc.fine': [['ファイン', 'FINE'], ['音の高さの微調整（セント）。AとBを少しずらすと厚みが出ます。', 'Fine tuning in cents. Slightly detuning A against B sounds thicker.']],
  'osc.coarse': [['コース', 'COARSE'], ['なめらかに変えられる音程。エンベロープで大きく動かすとキックやレーザー音に。', 'Continuous pitch offset. Sweep it with an envelope for kicks and laser zaps.']],
  'osc.unison': [['ユニゾン', 'UNISON'], ['同じ音を重ねる数。増やすと分厚く広がりのある音になります。', 'How many copies play together. More copies sound thicker and wider.']],
  'osc.detune': [['デチューン', 'DETUNE'], ['重ねた音どうしの音程のずれ。大きいほどうねりが強くなります。', 'How far the unison copies are detuned. More gives a stronger shimmer.']],
  'osc.blend': [['ブレンド', 'BLEND'], ['中央の音と、ずらした音のバランス。', 'Balance between the centre voice and the detuned ones.']],
  'osc.width': [['広がり', 'WIDTH'], ['重ねた音を左右に広げる量。', 'How far the unison copies spread left and right.']],
  'osc.phase': [['位相', 'PHASE'], ['波形のどこから鳴り始めるか。', 'Where in the waveform each note starts.']],
  'osc.rand': [['ランダム', 'RANDOM'], ['鳴らすたびに開始位置をばらつかせる量。0%にすると毎回同じアタックになります。', 'Randomises the start position per note. At 0% every attack is identical.']],
  'osc.warp': [['ワープ', 'WARP'], ['波形を変形させる方法。Sync は鋭く、Bend は偏らせ、FM/AM/RM はもう一方のオシレーターで変調します。', 'How the waveform is bent. Sync is sharp, Bend skews it, FM/AM/RM use the other oscillator.']],
  'osc.warpAmt': [['ワープ量', 'AMOUNT'], ['ワープのかかり具合。', 'How strongly the warp is applied.']],
  'osc.toFilter': [['フィルターへ', 'TO FILTER'], ['オンでフィルターを通ります。オフだとフィルターを迂回します。', 'On: goes through the filter. Off: bypasses it.']],

  'sub.on': [['電源', 'ON'], ['サブオシレーターを鳴らすかどうか。', 'Switch the sub oscillator on or off.']],
  'sub.shape': [['波形', 'SHAPE'], ['サブの波形。Sine は丸く、Square や Saw は存在感が出ます。', 'Waveform of the sub. Sine is round; square and saw cut through more.']],
  'sub.oct': [['オクターブ', 'OCTAVE'], ['メインの音から何オクターブ下（上）で鳴らすか。', 'Octaves below (or above) the played note.']],
  'sub.level': [['レベル', 'LEVEL'], ['サブの音量。', 'Volume of the sub.']],
  'sub.pan': [['パン', 'PAN'], ['左右の位置。', 'Left / right position.']],
  'sub.toFilter': [['フィルターへ', 'TO FILTER'], ['オンでフィルターを通ります。', 'On: goes through the filter.']],

  'noise.on': [['電源', 'ON'], ['ノイズを鳴らすかどうか。', 'Switch the noise on or off.']],
  'noise.type': [['種類', 'TYPE'], ['ノイズの種類。White は明るく、Pink・Brown は低め、Digital は粗く、Crackle はパチパチ。', 'Kind of noise: white is bright, pink and brown darker, digital is gritty, crackle pops.']],
  'noise.level': [['レベル', 'LEVEL'], ['ノイズの音量。', 'Volume of the noise.']],
  'noise.pan': [['パン', 'PAN'], ['左右の位置。', 'Left / right position.']],
  'noise.tone': [['トーン', 'TONE'], ['ノイズの明るさ（Digital は粗さ、Crackle は密度）。', 'Brightness of the noise (grit for Digital, density for Crackle).']],
  'noise.toFilter': [['フィルターへ', 'TO FILTER'], ['オンでフィルターを通ります。', 'On: goes through the filter.']],

  'filter.on': [['電源', 'ON'], ['フィルターを使うかどうか。オフにすると音はそのまま通ります。', 'Switch the filter on or off. When off the sound passes untouched.']],
  'filter.type': [['タイプ', 'TYPE'], ['フィルターの種類。LP は高音を削る、HP は低音を削る、BP は真ん中だけ通す。数字は削り方の急さ。', 'Kind of filter. LP removes highs, HP removes lows, BP keeps the middle. The number is how steep it is.']],
  'filter.cutoff': [['カットオフ', 'CUTOFF'], ['この周波数を境に音を削ります。ローパスなら、下げるほどこもり、上げるほど明るくなります。', 'The frequency where the filter starts cutting. With a low-pass: lower is darker, higher is brighter.']],
  'filter.res': [['レゾナンス', 'RES'], ['カットオフ付近を強調します。上げるとクセのある鋭い音に。', 'Boosts the area around the cutoff. Higher is sharper and more nasal.']],
  'filter.drive': [['ドライブ', 'DRIVE'], ['フィルターの手前で音を歪ませて太くします。', 'Overdrives the sound going into the filter for a fatter tone.']],
  'filter.var': [['VAR', 'VAR'], ['バリエーション。タイプによって働きが変わります。Morph：LP→BP→HP、Formant：母音、Comb：こもり具合、Phaser：広がり。', 'Depends on the type. Morph: LP to BP to HP. Formant: vowel. Comb: damping. Phaser: spread.']],
  'filter.mix': [['ミックス', 'MIX'], ['フィルターを通した音と、通す前の音の割合。', 'Balance between filtered and unfiltered sound.']],
  'filter.keytrack': [['キー追従', 'KEY TRACK'], ['高い音を弾くほどカットオフも上がるようにします。100%で音程と同じだけ動きます。', 'Raises the cutoff for higher notes. At 100% it follows the pitch exactly.']],
  'filter.stereo': [['ステレオ', 'STEREO'], ['左右でカットオフをずらして広がりを出します。', 'Offsets the cutoff between left and right for width.']],

  'env.attack': [['アタック', 'ATTACK'], ['鍵盤を押してから最大になるまでの時間。長くするとふわっと立ち上がります。', 'Time from key press to full level. Longer fades in softly.']],
  'env.hold': [['ホールド', 'HOLD'], ['最大のまま保つ時間。', 'Time it stays at full level.']],
  'env.decay': [['ディケイ', 'DECAY'], ['最大からサステインの高さまで下がる時間。短いと歯切れのよい音に。', 'Time to fall from full level to the sustain level. Short is plucky.']],
  'env.sustain': [['サステイン', 'SUSTAIN'], ['鍵盤を押している間、保たれる高さ。0%にすると押し続けても消えていきます。', 'Level held while the key is down. At 0% the note dies away even if held.']],
  'env.release': [['リリース', 'RELEASE'], ['鍵盤を離してから消えるまでの時間。長いと余韻が残ります。', 'Time to fade out after the key is released. Longer leaves a tail.']],
  'env.atkCurve': [['Aカーブ', 'A CURVE'], ['アタックの曲がり方。＋で最初に速く、－で最初はゆっくり。', 'Bend of the attack. Positive is fast first, negative starts slowly.']],
  'env.decCurve': [['Dカーブ', 'D CURVE'], ['ディケイの曲がり方。＋で最初に速く落ちる自然な減衰に。', 'Bend of the decay. Positive drops fast first, like a natural decay.']],
  'env.relCurve': [['Rカーブ', 'R CURVE'], ['リリースの曲がり方。', 'Bend of the release.']],

  'lfo.shape': [['波形', 'SHAPE'], ['揺れ方の形。Custom を選ぶと自分で描けます。', 'The shape of the wobble. Choose Custom to draw your own.']],
  'lfo.rate': [['速さ', 'RATE'], ['揺れる速さ（1秒間に何回か）。', 'How fast it cycles, in times per second.']],
  'lfo.sync': [['テンポ同期', 'SYNC'], ['オンで速さをテンポ（音符の長さ）に合わせます。', 'On: the speed locks to the tempo, in note lengths.']],
  'lfo.div': [['音符', 'NOTE'], ['1周の長さを音符で指定します。1/4 は4分音符、T は3連、. は付点。', 'Length of one cycle as a note value. T is triplet, a dot is dotted.']],
  'lfo.mode': [['モード', 'MODE'], ['Trig：弾くたびに最初から。Env：1回だけ動いて止まる（エンベロープのように使える）。Free：ずっと動き続ける。', 'Trig: restarts with each note. Env: runs once and stops, like an envelope. Free: never stops.']],
  'lfo.rise': [['ライズ', 'RISE'], ['揺れがだんだん大きくなるまでの時間。遅れてかかるビブラートなどに。', 'Time for the wobble to fade in. Good for delayed vibrato.']],
  'lfo.delay': [['ディレイ', 'DELAY'], ['揺れ始めるまでの待ち時間。', 'Wait before the wobble starts.']],
  'lfo.smooth': [['スムーズ', 'SMOOTH'], ['形の角を丸めます。', 'Rounds off sharp corners of the shape.']],
  'lfo.phase': [['位相', 'PHASE'], ['形のどこから始めるか。', 'Where in the shape it starts.']],

  'hyper.on': [['電源', 'ON'], ['', '']],
  'hyper.rate': [['速さ', 'RATE'], ['重ねた音が揺れる速さ。', 'How fast the added voices drift.']],
  'hyper.detune': [['デチューン', 'DETUNE'], ['重ねた音の音程のずれ。', 'How far the added voices are detuned.']],
  'hyper.voices': [['ボイス数', 'VOICES'], ['重ねる数。', 'How many voices are added.']],
  'hyper.mix': [['ミックス', 'MIX'], ['エフェクト音の量。', 'Amount of the effect.']],
  'hyper.dimSize': [['サイズ', 'SIZE'], ['ディメンション（ステレオの広がり）の大きさ。', 'Size of the Dimension stereo widener.']],
  'hyper.dimMix': [['広がり', 'DIMENSION'], ['ディメンション。ステレオを広げる効果の量。', 'Amount of stereo widening.']],

  'dist.on': [['電源', 'ON'], ['', '']],
  'dist.mode': [['タイプ', 'TYPE'], ['歪みの種類。Tube・Soft は温かく、Hard・Fold は激しく、Bitcrush・Downsample はローファイに。', 'Kind of distortion. Tube and Soft are warm, Hard and Fold aggressive, Bitcrush and Downsample lo-fi.']],
  'dist.drive': [['ドライブ', 'DRIVE'], ['歪みの強さ。', 'How hard it distorts.']],
  'dist.mix': [['ミックス', 'MIX'], ['歪ませた音と元の音の割合。', 'Balance between distorted and clean sound.']],
  'dist.filterMode': [['フィルター', 'FILTER'], ['歪みの前（Pre）か後（Post）にフィルターをかけます。', 'Adds a filter before (Pre) or after (Post) the distortion.']],
  'dist.filterType': [['種類', 'KIND'], ['フィルターの種類。', 'Kind of filter.']],
  'dist.filterFreq': [['周波数', 'FREQ'], ['フィルターの周波数。', 'Filter frequency.']],
  'dist.filterQ': [['Q', 'Q'], ['フィルターの鋭さ。', 'Filter sharpness.']],

  'flanger.on': [['電源', 'ON'], ['', '']],
  'flanger.rate': [['速さ', 'RATE'], ['うねりの速さ。', 'Speed of the sweep.']],
  'flanger.depth': [['深さ', 'DEPTH'], ['うねりの深さ。', 'Depth of the sweep.']],
  'flanger.feedback': [['FB', 'FEEDBACK'], ['フィードバック。上げると金属的で強いクセが出ます。', 'More feedback sounds more metallic and resonant.']],
  'flanger.phase': [['ステレオ', 'STEREO'], ['左右のうねりのずれ。', 'Offset of the sweep between left and right.']],
  'flanger.mix': [['ミックス', 'MIX'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'phaser.on': [['電源', 'ON'], ['', '']],
  'phaser.rate': [['速さ', 'RATE'], ['うねりの速さ。', 'Speed of the sweep.']],
  'phaser.depth': [['深さ', 'DEPTH'], ['うねりの深さ。', 'Depth of the sweep.']],
  'phaser.freq': [['周波数', 'FREQ'], ['うねりの中心となる高さ。', 'Centre of the sweep.']],
  'phaser.feedback': [['FB', 'FEEDBACK'], ['フィードバック。上げると効果が強くなります。', 'More feedback makes it more pronounced.']],
  'phaser.phase': [['ステレオ', 'STEREO'], ['左右のうねりのずれ。', 'Offset of the sweep between left and right.']],
  'phaser.mix': [['ミックス', 'MIX'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'chorus.on': [['電源', 'ON'], ['', '']],
  'chorus.rate': [['速さ', 'RATE'], ['揺れの速さ。', 'Speed of the wobble.']],
  'chorus.delay1': [['ディレイ1', 'DELAY 1'], ['1つ目の遅らせる時間。', 'First delay time.']],
  'chorus.delay2': [['ディレイ2', 'DELAY 2'], ['2つ目の遅らせる時間。', 'Second delay time.']],
  'chorus.depth': [['深さ', 'DEPTH'], ['揺れの深さ。', 'Depth of the wobble.']],
  'chorus.feedback': [['FB', 'FEEDBACK'], ['フィードバック。上げると効果が強くなります。', 'More feedback makes it more pronounced.']],
  'chorus.lpf': [['ローパス', 'LPF'], ['エフェクト音の高音を削ります。', 'Removes highs from the effect.']],
  'chorus.mix': [['ミックス', 'MIX'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'delay.on': [['電源', 'ON'], ['', '']],
  'delay.sync': [['テンポ同期', 'SYNC'], ['オンで、やまびこの間隔をテンポに合わせます。', 'On: the echo time locks to the tempo.']],
  'delay.timeL': [['時間 L', 'TIME L'], ['左のやまびこが返ってくるまでの時間。', 'Echo time on the left.']],
  'delay.timeR': [['時間 R', 'TIME R'], ['右のやまびこが返ってくるまでの時間。', 'Echo time on the right.']],
  'delay.divL': [['音符 L', 'NOTE L'], ['左のやまびこの間隔（音符）。', 'Echo time on the left as a note value.']],
  'delay.divR': [['音符 R', 'NOTE R'], ['右のやまびこの間隔（音符）。', 'Echo time on the right as a note value.']],
  'delay.link': [['LRリンク', 'LINK'], ['オンで左右を同じ時間にします。', 'On: left and right use the same time.']],
  'delay.feedback': [['くり返し', 'FEEDBACK'], ['フィードバック。やまびこがくり返す回数。上げるほど長く続きます。', 'How many times the echo repeats. Higher lasts longer.']],
  'delay.mode': [['モード', 'MODE'], ['Normal：左右それぞれ。PingPong：左右に行ったり来たり。Tap：左に1回、右にくり返し。', 'Normal: each side on its own. PingPong: bounces left and right. Tap: one echo left, repeats right.']],
  'delay.filterFreq': [['トーン', 'TONE'], ['やまびこの音色の中心。くり返すたびにこの帯域に寄っていきます。', 'Tone of the echoes. Each repeat narrows towards this frequency.']],
  'delay.filterQ': [['幅', 'FOCUS'], ['上げるほど、やまびこが細い音になっていきます。', 'Higher makes the echoes thinner.']],
  'delay.mix': [['ミックス', 'MIX'], ['やまびこの音量。', 'Level of the echoes.']],

  'comp.on': [['電源', 'ON'], ['', '']],
  'comp.threshold': [['しきい値', 'THRESHOLD'], ['スレッショルド。この音量を超えた分を抑えます。下げるほど強くかかります。', 'Sound above this level is turned down. Lower compresses more.']],
  'comp.ratio': [['レシオ', 'RATIO'], ['抑える強さ。4:1なら、超えた分を1/4に。', 'How strongly it turns down. 4:1 lets a quarter of the excess through.']],
  'comp.attack': [['アタック', 'ATTACK'], ['抑え始めるまでの速さ。', 'How fast it reacts.']],
  'comp.release': [['リリース', 'RELEASE'], ['抑えるのをやめるまでの速さ。', 'How fast it lets go.']],
  'comp.gain': [['ゲイン', 'GAIN'], ['抑えて小さくなった分を持ち上げます。', 'Makes up for the level lost by compressing.']],
  'comp.multiband': [['マルチバンド', 'MULTIBAND'], ['低・中・高の3つに分けて別々に抑えます。派手で密度の高い音に。', 'Splits into low, mid and high and compresses each. Dense and bright.']],
  'comp.mix': [['ミックス', 'MIX'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'reverb.on': [['電源', 'ON'], ['', '']],
  'reverb.mode': [['タイプ', 'TYPE'], ['Plate：明るく密な響き。Hall：広いホールの響き。', 'Plate: bright and dense. Hall: a large room.']],
  'reverb.size': [['サイズ', 'SIZE'], ['空間の広さ。', 'Size of the space.']],
  'reverb.decay': [['長さ', 'DECAY'], ['響きが消えるまでの長さ。', 'How long the reverb rings.']],
  'reverb.predelay': [['Pディレイ', 'PREDELAY'], ['プリディレイ。響きが始まるまでの間。少し空けると元の音がはっきりします。', 'Gap before the reverb starts. A little keeps the dry sound clear.']],
  'reverb.lowcut': [['ローカット', 'LOW CUT'], ['響きの低音を削ります。', 'Removes lows from the reverb.']],
  'reverb.highcut': [['ハイカット', 'HIGH CUT'], ['響きの高音を削ります。', 'Removes highs from the reverb.']],
  'reverb.damp': [['ダンプ', 'DAMP'], ['響きの高音が先に消えていく度合い。', 'How quickly the highs of the tail die away.']],
  'reverb.width': [['広がり', 'WIDTH'], ['響きの左右の広がり。', 'Stereo width of the reverb.']],
  'reverb.mix': [['ミックス', 'MIX'], ['響きの量。', 'Amount of reverb.']],

  'eq.on': [['電源', 'ON'], ['', '']],
  'eq.lowType': [['低域の形', 'LOW KIND'], ['Shelf：それより下を全体に。Peak：その付近だけ。HP：それより下をカット。', 'Shelf: everything below. Peak: just around it. HP: cut everything below.']],
  'eq.lowFreq': [['低域 周波数', 'LOW FREQ'], ['低域の周波数。', 'Frequency of the low band.']],
  'eq.lowQ': [['低域 Q', 'LOW Q'], ['低域の鋭さ。', 'Sharpness of the low band.']],
  'eq.lowGain': [['低域 ゲイン', 'LOW GAIN'], ['低域を上げ下げする量。', 'Boost or cut of the low band.']],
  'eq.highType': [['高域の形', 'HIGH KIND'], ['Shelf：それより上を全体に。Peak：その付近だけ。LP：それより上をカット。', 'Shelf: everything above. Peak: just around it. LP: cut everything above.']],
  'eq.highFreq': [['高域 周波数', 'HIGH FREQ'], ['高域の周波数。', 'Frequency of the high band.']],
  'eq.highQ': [['高域 Q', 'HIGH Q'], ['高域の鋭さ。', 'Sharpness of the high band.']],
  'eq.highGain': [['高域 ゲイン', 'HIGH GAIN'], ['高域を上げ下げする量。', 'Boost or cut of the high band.']],

  'fxfilter.on': [['電源', 'ON'], ['', '']],
  'fxfilter.type': [['タイプ', 'TYPE'], ['フィルターの種類。', 'Kind of filter.']],
  'fxfilter.cutoff': [['カットオフ', 'CUTOFF'], ['全体の音を削る周波数。', 'Cutoff applied to the whole sound.']],
  'fxfilter.res': [['レゾナンス', 'RES'], ['カットオフ付近の強調。', 'Emphasis around the cutoff.']],
  'fxfilter.drive': [['ドライブ', 'DRIVE'], ['手前での歪み。', 'Overdrive into the filter.']],
  'fxfilter.var': [['VAR', 'VAR'], ['バリエーション。タイプによって働きが変わります。', 'Depends on the type.']],
  'fxfilter.mix': [['ミックス', 'MIX'], ['エフェクト音の割合。', 'Amount of the effect.']],
};

const FX = {
  hyper: [['ハイパー', 'HYPER'], ['音を重ねて厚くする', 'Stacks copies for thickness']],
  dist: [['ディストーション', 'DISTORTION'], ['歪ませて荒々しく', 'Adds grit and bite']],
  flanger: [['フランジャー', 'FLANGER'], ['シュワーっとうねる', 'A jet-like sweep']],
  phaser: [['フェイザー', 'PHASER'], ['ゆっくり色が変わる', 'A slow swirling colour']],
  chorus: [['コーラス', 'CHORUS'], ['揺らして広げる', 'Wobbles and widens']],
  delay: [['ディレイ', 'DELAY'], ['やまびこ', 'Echoes']],
  comp: [['コンプレッサー', 'COMPRESSOR'], ['音量の差をならす', 'Evens out the level']],
  reverb: [['リバーブ', 'REVERB'], ['部屋やホールの響き', 'Room and hall ambience']],
  eq: [['EQ', 'EQ'], ['低音と高音の調整', 'Adjusts lows and highs']],
  fxfilter: [['フィルター', 'FILTER'], ['全体にかけるフィルター', 'A filter on everything']],
};

const SOURCE = {
  none: [['なし', 'None'], ['', '']],
  env1: [['ENV 1', 'ENV 1'], ['音量用のエンベロープ', 'The amp envelope']],
  env2: [['ENV 2', 'ENV 2'], ['', '']],
  env3: [['ENV 3', 'ENV 3'], ['', '']],
  lfo1: [['LFO 1', 'LFO 1'], ['', '']],
  lfo2: [['LFO 2', 'LFO 2'], ['', '']],
  lfo3: [['LFO 3', 'LFO 3'], ['', '']],
  lfo4: [['LFO 4', 'LFO 4'], ['', '']],
  velocity: [['ベロシティ', 'Velocity'], ['鍵盤を弾く強さ', 'How hard you play']],
  note: [['ノート', 'Note'], ['弾いた音の高さ', 'Which note you play']],
  modWheel: [['MODホイール', 'Mod wheel'], ['MIDIキーボードのホイール（画面のスライダーでも動かせます）', 'The wheel on a MIDI keyboard (or the on-screen slider)']],
  aftertouch: [['アフタータッチ', 'Aftertouch'], ['鍵盤を押し込む強さ', 'Pressing into a held key']],
  pitchBend: [['ピッチベンド', 'Pitch bend'], ['ピッチベンドホイール', 'The pitch wheel']],
  macro1: [['マクロ 1', 'Macro 1'], ['', '']],
  macro2: [['マクロ 2', 'Macro 2'], ['', '']],
  macro3: [['マクロ 3', 'Macro 3'], ['', '']],
  macro4: [['マクロ 4', 'Macro 4'], ['', '']],
  random: [['ランダム', 'Random'], ['弾くたびに変わる値', 'A new value for every note']],
};

// Friendlier names for some menu options; the rest are shown as they are.
const OPTION = {
  Off: ['オフ', 'Off'],
  SyncWin: ['Sync (窓あり)', 'Sync (window)'],
  SawUp: ['ノコギリ ↗', 'Saw up'],
  SawDown: ['ノコギリ ↘', 'Saw down'],
  Sine: ['サイン', 'Sine'],
  Triangle: ['三角', 'Triangle'],
  Square: ['矩形', 'Square'],
  Saw: ['ノコギリ', 'Saw'],
  Pulse: ['パルス', 'Pulse'],
  Round: ['丸い矩形', 'Round'],
  'S&H': ['ランダム階段', 'Random steps'],
  Smooth: ['なめらかランダム', 'Smooth random'],
  Custom: ['Custom（描く）', 'Custom (draw)'],
};

function generic(key) {
  return key
    .replace(/^osc[AB]\./, 'osc.')
    .replace(/^env\d\./, 'env.')
    .replace(/^lfo\d\./, 'lfo.')
    .replace(/^macro\d$/, 'macro');
}

export function detectLang() {
  try {
    const saved = localStorage.getItem('nami.lang');
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage may be unavailable */
  }
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function createI18n(lang) {
  const li = lang === 'ja' ? 0 : 1;
  const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : text);
  return {
    lang,
    /** UI string by key. Falls back to the key itself so gaps are visible. */
    t(key, vars) {
      const e = UI[key];
      return e ? fill(e[li], vars) : key;
    },
    paramLabel(key) {
      const e = PARAM[generic(key)];
      if (!e) return key;
      const m = /^macro(\d)$/.exec(key);
      return m ? `${e[0][li]} ${m[1]}` : e[0][li];
    },
    paramHelp(key) {
      const g = generic(key);
      const e = PARAM[g];
      if (e && e[1][li]) return e[1][li];
      // Effect power switches share one description.
      const fx = FX[key.split('.')[0]];
      if (fx && key.endsWith('.on')) return fx[1][li];
      return '';
    },
    /** Full name of a parameter including its module, e.g. "OSC A · WT POS". */
    paramTitle(key) {
      const [mod] = key.split('.');
      const names = {
        oscA: 'OSC A', oscB: 'OSC B', sub: 'SUB', noise: 'NOISE', master: lang === 'ja' ? '全体' : 'GLOBAL',
        filter: this.t('mod.filter'),
      };
      let module = names[mod];
      if (!module) {
        const env = /^env(\d)$/.exec(mod);
        const lfo = /^lfo(\d)$/.exec(mod);
        if (env) module = `ENV ${env[1]}`;
        else if (lfo) module = `LFO ${lfo[1]}`;
        else if (FX[mod]) module = FX[mod][0][li];
      }
      const label = this.paramLabel(key);
      return module && !/^macro/.test(key) ? `${module} · ${label}` : label;
    },
    fxName: (key) => (FX[key] ? FX[key][0][li] : key),
    fxRole: (key) => (FX[key] ? FX[key][1][li] : ''),
    sourceName: (key) => (SOURCE[key] ? SOURCE[key][0][li] : key),
    sourceHelp: (key) => (SOURCE[key] ? SOURCE[key][1][li] : ''),
    option: (name) => (OPTION[name] ? OPTION[name][li] : name),
  };
}

/** Exposed for tests: every parameter must have a label. */
export function hasParamText(key) {
  return !!PARAM[generic(key)];
}
