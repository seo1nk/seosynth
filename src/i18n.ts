// All user-facing text, Japanese and English.
// Entries are [ja, en]. Parameter texts are [label, help].

export type Lang = 'ja' | 'en';
export const LANGS: Lang[] = ['ja', 'en'];

/** [Japanese, English] */
type Pair = [string, string];

const UI: Record<string, Pair> = {
  'app.title': ['seosynth | ブラウザで動くウェーブテーブルシンセ', 'seosynth | a wavetable synth in your browser'],
  'audio.error': ['音を出す準備ができませんでした。ページを読み込み直してください。', 'Audio could not start. Reload the page to try again.'],

  // The board
  'board.title': ['音の流れ', 'Signal flow'],
  'board.hint': [
    'ノードを押すと設定が開きます。スイッチを入れたノードを通って、音が出力まで流れます。',
    'Press a node to open its settings. Sound flows through every node that is switched on, all the way to the output.',
  ],
  'board.movers': ['うごき：スライダーを自動で動かす', 'Movement: moves sliders for you'],
  'board.addMover': ['うごきを足す', 'Add movement'],
  'board.tray': [
    '使っていないエフェクト（スイッチを入れると流れに加わります。同じものは 3 つまで）',
    'Effects not in use (switch one on to add it to the flow; up to three of each)',
  ],
  'board.fit': ['全体を表示', 'Fit'],
  'board.zoomIn': ['拡大', 'Zoom in'],
  'board.zoomOut': ['縮小', 'Zoom out'],
  'mover.lfo': ['LFO', 'LFO'],
  'mover.lfo.what': ['くり返し揺らす。ビブラートやうねりに。', 'Wobbles over and over: vibrato, sweeps.'],
  'mover.env': ['エンベロープ', 'Envelope'],
  'mover.env.what': ['弾くたびに一度だけ動く。アタックの変化に。', 'Runs once per note: shapes the attack.'],
  'mover.macro': ['マクロ', 'Macro'],
  'mover.macro.what': ['自分で動かすスライダー。複数をまとめて操作。', 'A slider of your own that moves several others.'],
  'mover.play': ['弾き方で動かす', 'Moved by how you play'],

  // The settings panel
  'panel.on': ['オン', 'On'],
  'panel.more': ['くわしい設定', 'More settings'],
  'panel.removeMover': ['「{name}」をボードから外す', 'Remove {name} from the board'],
  'io.in': ['入る音', 'Sound in'],
  'io.out': ['出る音', 'Sound out'],
  'io.outOnly': ['このノードから出る音', 'Sound leaving this node'],
  'out.level': ['音量メーター', 'Level meter'],
  'order.title': ['順番', 'Order'],
  'order.title.split': ['分岐の場所', 'Where it splits'],
  'order.earlier': ['前へ', 'Earlier'],
  'order.later': ['後ろへ', 'Later'],
  'order.place': ['{n} / {total} 番目', '{n} of {total}'],
  'order.help': [
    'エフェクトは流れの順にかかります。歪み→リバーブと、リバーブ→歪みでは違う音になります。',
    'Effects are applied in order: distortion into reverb sounds different from reverb into distortion.',
  ],
  'order.help.split': [
    '分岐を、流れの中で前や後ろへ動かします。分岐より前のエフェクトは両方の道に、後ろのエフェクトはまとめた音にかかります。',
    'Moves the split earlier or later. Effects before it reach both lanes; effects after it work on the mixed result.',
  ],
  'place.title': ['流れの中の場所', 'Place in the flow'],

  // Wavetables of your own
  'table.user': ['自分のテーブル {n}', 'My table {n}'],
  'table.mine': ['自分で作る（描く・音声から作る）', 'Make your own (draw it, or use a recording)'],
  'table.edit': ['描く・音声から作る', 'Draw or import'],
  'table.edit.help': [
    '波形を自分で描いたり、音声ファイルから取り込んだりして、自分だけのウェーブテーブルを作ります。',
    'Draw the waveform yourself, or take it from an audio file, to make a wavetable of your own.',
  ],
  'editor.title': ['{name} を作る', 'Make your own: {name}'],
  'editor.intro': [
    '枠の中をなぞって、音の波 1 回ぶんの形を描きます。この形がくり返されて音になります。鍵盤や PC のキーで鳴らしながら描けます。高さは音量に関係しません（自動でそろえます）。',
    'Drag inside the frame to draw one cycle of the sound wave. This shape repeats to make the tone. Play the keyboard or your computer keys while you draw. The height does not change the loudness (that is evened out for you).',
  ],
  'editor.canvas': ['波形を描くところ', 'Drawing area'],
  'editor.start': ['はじめの形', 'Start from'],
  'editor.smooth': ['なめらかにする', 'Smooth'],
  'editor.listen': ['押しているあいだ鳴らす', 'Hold to listen'],
  'editor.frames': ['コマ', 'Frames'],
  'editor.frames.help': [
    '＋でコマを足すと、波形をいくつも並べられます。「波形の位置」を動かすと、パラパラ漫画のようにコマからコマへ形が変わっていきます。うすい線は次のコマです。',
    'Add frames with + to line up several shapes. Moving "Wave position" morphs from frame to frame, like a flip book. The faint line is the next frame.',
  ],
  'editor.frame': ['コマ {n}', 'Frame {n}'],
  'editor.addFrame': ['コマを足す（いまのコマのコピー）', 'Add a frame (a copy of this one)'],
  'editor.removeFrame': ['このコマを消す', 'Delete this frame'],
  'editor.import.title': ['音声から作る', 'Make it from a recording'],
  'editor.import.body': [
    '声や楽器などの音声ファイルを選ぶと（ここにドロップしても OK）、その音の波形をコマとして取り込みます。いまのコマは置き換わります。',
    'Choose an audio file of a voice, an instrument or anything else (or drop it here) and its waveforms become the frames. The current frames are replaced.',
  ],
  'editor.import.choose': ['音声ファイルを選ぶ', 'Choose an audio file'],
  'editor.import.count': ['コマ数', 'Frames'],
  'editor.import.working': ['解析しています…', 'Analysing...'],
  'editor.import.done': ['{n} コマを取り込みました（音の高さ：約 {hz} Hz）', 'Imported {n} frames (pitch: about {hz} Hz)'],
  'editor.import.one': [
    '音の形がずっと同じだったので、1 コマにまとめました（音の高さ：約 {hz} Hz）',
    'The sound kept one shape throughout, so it became a single frame (pitch: about {hz} Hz)',
  ],
  'editor.import.unpitched': [
    'はっきりした音の高さが見つからなかったので、一定の長さで {n} コマに切り取りました',
    'No steady pitch was found, so {n} slices of a fixed length were taken',
  ],
  'editor.import.failed': ['この音声ファイルは読み込めませんでした', 'This audio file could not be read'],
  'editor.import.silent': ['音が入っていないようです', 'The file seems to be silent'],
  'editor.reset': ['サインに戻す', 'Back to a sine'],
  'editor.done': ['できた', 'Done'],
  'lane.title': ['通る道', 'Lane'],
  'lane.main': ['本線', 'Main line'],
  'lane.help': [
    '音を 2 つの道に分けて、片方にだけこのエフェクトをかけられます。たとえば高音だけを歪ませたり、ディレイとリバーブを別々にかけたりできます。分け方は、ボードにできる「分岐」ノードで選びます。',
    'Splits the sound into two lanes so this effect works on only one of them: distort just the highs, or keep delay and reverb apart. Choose how the sound is divided in the "Split" node that appears on the board.',
  ],
  'lane.carries': ['{name}：この道を通る音', '{name}: sound on this lane'],
  'lane.empty': ['エフェクトなし（そのまま通る）', 'no effects (passes through)'],
  'lane.Copy.a': ['A', 'A'],
  'lane.Copy.b': ['B', 'B'],
  'lane.Copy.a.only': ['分岐 A', 'Lane A'],
  'lane.Copy.b.only': ['分岐 B', 'Lane B'],
  'lane.Bands.a': ['低音', 'Lows'],
  'lane.Bands.b': ['高音', 'Highs'],
  'lane.Bands.a.only': ['低音だけ', 'Lows only'],
  'lane.Bands.b.only': ['高音だけ', 'Highs only'],
  'lane.MidSide.a': ['中央', 'Centre'],
  'lane.MidSide.b': ['左右', 'Sides'],
  'lane.MidSide.a.only': ['中央だけ', 'Centre only'],
  'lane.MidSide.b.only': ['左右だけ', 'Sides only'],
  'lane.LeftRight.a': ['左', 'Left'],
  'lane.LeftRight.b': ['右', 'Right'],
  'lane.LeftRight.a.only': ['左だけ', 'Left only'],
  'lane.LeftRight.b.only': ['右だけ', 'Right only'],
  'stack.add': ['同じものをもう 1 つ重ねる', 'Stack another one'],
  'stack.count': ['{n} / {total} 個を使用中', '{n} of {total} in use'],
  'stack.help': [
    '同じエフェクトを 3 つまで重ねられます。いまの設定をコピーして、すぐ後ろに置きます。',
    'The same effect can be stacked up to three times. The new one copies these settings and goes right behind this one.',
  ],
  'split.remove': ['分岐をやめて 1 本に戻す', 'Remove the split'],
  'filter.group.low': ['ローパス（高音を削る）', 'Low-pass (removes highs)'],
  'filter.group.high': ['ハイパス（低音を削る）', 'High-pass (removes lows)'],
  'filter.group.band': ['バンド系', 'Band'],
  'filter.group.special': ['特殊', 'Special'],

  // Connections between movers and sliders
  'mod.add': ['このスライダーを自動で動かす', 'Make this slider move by itself'],
  'mod.sentence': ['{src}が「{dst}」を動かす', '{src} moves {dst}'],
  'mod.menuTitle': ['「{name}」を動かす', 'Move {name}'],
  'mod.choose': ['何で動かしますか', 'Move it with'],
  'reach.title': ['つないでいるスライダー', 'Connected sliders'],
  'reach.env1': ['このエンベロープでほかのスライダーも動かす', 'Move other sliders with this envelope too'],
  'reach.empty': ['まだどこにもつないでいません。下でつなぐ先を選んでください。', 'Not connected to anything yet. Choose where to connect it below.'],
  'moved.title': ['このノードを動かしているもの', 'What is moving this node'],
  'link.node': ['どのノードの', 'Which node'],
  'link.param': ['どのスライダーを', 'Which slider'],
  'link.connect': ['つなぐ', 'Connect'],
  'matrix.title': ['つながりの一覧', 'All connections'],
  'matrix.empty': ['まだつながりがありません。ボードの「うごきを足す」から始められます。', 'No connections yet. Start with "Add movement" on the board.'],
  'matrix.amount': ['動かす量', 'Amount'],
  'matrix.bipolar': ['上下に', 'Both ways'],
  'matrix.bipolar.help': [
    'オフ：スライダーの位置から片側へ動かす。オン：スライダーの位置を中心に上下へ動かす。',
    'Off: moves one way from the slider position. On: swings both ways around it.',
  ],
  'matrix.more': ['くわしく', 'More'],
  'matrix.more.help': ['動き方の曲げと、強さを決めるものを設定します。', 'Set how the movement bends and what scales it.'],
  'matrix.curve': ['曲げ', 'Curve'],
  'matrix.curve.help': [
    '動きの効き方を曲げます。プラスにすると少し動かしただけで大きく効き、マイナスにすると最後のほうで一気に効きます。0 でまっすぐ。ダブルクリックで 0 に戻ります。',
    'Bends how the movement takes effect. Above 0 a small movement already does a lot; below 0 most of it happens near the end. 0 is straight. Double-click to reset.',
  ],
  'matrix.aux': ['強さを決めるもの', 'Scaled by'],
  'matrix.aux.none': ['なし（いつも同じ強さ）', 'Nothing (always full)'],
  'matrix.aux.help': [
    'ここで選んだものが、このつながりの強さを決めます。たとえばモジュレーションホイールを選ぶと、ホイールを上げたときだけ動くようになります。',
    'What you pick here sets how strong this connection is. Pick the mod wheel, for example, and it only moves when the wheel is up.',
  ],
  'matrix.remove': ['つながりを外す', 'Remove this connection'],
  'matrix.full': ['つながりの数が上限（{n}）に達しています。', 'All {n} connections are in use.'],
  'hint.modAmount': ['押すと、動かす量を変えたり外したりできます。', 'Press to change how far it moves, or to remove it.'],
  'menu.reset': ['初期値に戻す', 'Reset to default'],
  'menu.enter': ['数値で入力', 'Type a value'],
  'menu.enter.prompt': ['新しい値', 'new value'],

  // Top bar
  'preset.title': ['音色を選ぶ', 'Choose a sound'],
  'preset.label': ['音色', 'Sound'],
  'cat.basic': ['きほん', 'Basics'],
  'lesson.learn': ['学ぶ', 'Learn'],
  'lesson.learn.help': ['「{name}」を、はじめの音から組み立てながら学ぶ', 'Learn by building "{name}" from the plain starting sound'],
  'lesson.intro.title': ['「{name}」を組み立てる', 'Build "{name}"'],
  'lesson.intro.body': [
    'はじめの音（ノコギリ波）から、{n} つのステップで「{name}」を作ります。それぞれのステップで、書いてある値にスライダーやスイッチを合わせましょう。合うと ✓ がつきます。迷ったら「代わりにやる」を押してください。',
    'Starting from the plain saw, you build "{name}" in {n} steps. In each step, set the sliders and switches to the values listed; each one gets a ✓ when it matches. Stuck? Press "Do it for me".',
  ],
  'lesson.intro.prepared': ['描いた形やフレーズなど、スライダーでは作れないものは先に用意してあります。', 'Things sliders cannot make, such as drawn shapes and phrases, are already in place.'],
  'lesson.started': ['レッスンを始めました。前の音色は「元に戻す」で戻せます。', 'Lesson started. Undo brings back the sound you had.'],
  'lesson.start': ['始める', 'Start'],
  'lesson.doIt': ['代わりにやる', 'Do it for me'],
  'lesson.end': ['レッスンを終える', 'End the lesson'],
  'lesson.finish': ['終わる', 'Finish'],
  'lesson.collapse': ['たたむ', 'Collapse'],
  'lesson.expand': ['ひらく', 'Expand'],
  'lesson.keys': ['鍵盤の鳴らし方', 'How the keys play'],
  'lesson.keys.role': ['鍵盤の上の「鳴らし方」と、その設定です。', '"Keys play" above the keyboard and its settings.'],
  'lesson.open': ['ボードの「{name}」を押して、設定を開きましょう。', 'Press "{name}" on the board to open its settings.'],
  'lesson.mod': ['{sentence}：強さ {amount}', '{sentence}: amount {amount}'],
  'lesson.done.title': ['できあがり', 'All done'],
  'lesson.done.body': ['「聴く」で鳴らして、できあがった音を確かめましょう。ここからは自由に変えてみてください。', 'Press "Listen" to hear what you built. From here, change anything you like.'],
  'cat.bass': ['ベース', 'Bass'],
  'cat.lead': ['リード', 'Lead'],
  'cat.pad': ['パッド', 'Pad'],
  'cat.pluck': ['プラック', 'Pluck'],
  'cat.keys': ['キー', 'Keys'],
  'cat.fx': ['効果音', 'Sound effects'],
  'btn.listen': ['聴く', 'Listen'],
  'btn.listen.help': ['短いフレーズをくり返し演奏します。聴きながら調整できます。', 'Plays a short phrase on repeat so you can adjust while listening.'],
  'btn.stop': ['止める', 'Stop'],
  'btn.prev': ['前の音色', 'Previous sound'],
  'btn.next': ['次の音色', 'Next sound'],
  'btn.prevOption': ['前の候補', 'Previous option'],
  'btn.nextOption': ['次の候補', 'Next option'],
  'btn.undo': ['元に戻す', 'Undo'],
  'btn.redo': ['やり直す', 'Redo'],
  'btn.share': ['共有', 'Share'],
  'btn.menu': ['メニュー', 'Menu'],
  'btn.close': ['閉じる', 'Close'],
  'btn.copy': ['リンクをコピー', 'Copy link'],
  'btn.copied': ['コピーしました', 'Copied'],
  'btn.hold': ['ホールド', 'Hold'],
  'menu.new': ['新しい音色を作る', 'Start a new sound'],
  'menu.lang': ['ことば', 'Language'],
  'menu.theme': ['画面の色', 'Appearance'],
  'theme.auto': ['自動', 'Auto'],
  'theme.light': ['明るい', 'Light'],
  'theme.dark': ['暗い', 'Dark'],
  'file.importJson': ['ファイルから開く', 'Open from a file'],
  'file.exportJson': ['ファイルに保存', 'Save to a file'],
  'file.exportSerum': ['Serum 2 用に書き出す', 'Export for Serum 2'],
  'file.imported': ['音色を開きました', 'Sound opened'],
  'file.importFailed': ['このファイルは開けませんでした。seosynth で保存した .json ファイルを選んでください。', 'This file could not be opened. Choose a .json file saved from seosynth.'],
  'file.exported': ['保存しました', 'Saved'],
  'toast.patchInit': ['新しい音色を作りました', 'Started a new sound'],

  // Sharing
  'share.title': ['この音色を共有', 'Share this sound'],
  'share.body': [
    'このリンクを開くと、いまの音色がそのまま再現されます。設定はリンクの中に入っているので、サーバーには何も保存されません。',
    'Opening this link recreates the sound exactly as it is now. The settings are inside the link itself; nothing is stored on a server.',
  ],
  'share.name': ['音色の名前', 'Name of the sound'],
  'share.link': ['リンク', 'Link'],
  'share.long': [
    '長いリンクです（自分で作ったテーブルが入っています）。アプリによっては途中で切れることがあります。うまく開けないときは、メニューの「ファイルに保存」を使ってください。',
    'This is a long link (it carries a table you made). Some apps cut long links short; if it does not open, use "Save to file" in the menu instead.',
  ],
  'share.native': ['ほかのアプリで共有', 'Share with another app'],
  'share.loaded': ['共有された音色を開きました', 'Opened the shared sound'],
  'share.invalid': ['このリンクの音色は読み取れませんでした。リンクが途中で切れていないか確認してください。', 'The sound in this link could not be read. Check that the link was not cut short.'],

  // Keyboard
  'kb.toggle': ['鍵盤を表示', 'Show the keyboard'],
  'kb.octave': ['オクターブ', 'Octave'],
  'kb.octave.down': ['オクターブを下げる', 'Octave down'],
  'kb.octave.up': ['オクターブを上げる', 'Octave up'],
  'kb.hold.help': ['オンにすると、鍵盤を離しても音が鳴り続けます。', 'When on, notes keep sounding after you let go.'],
  'kb.settings': ['弾き方の設定', 'Playing settings'],
  'kb.piano': ['鍵盤', 'Keyboard'],
  'toast.region': ['お知らせ', 'Notifications'],
  'kb.midi.help': ['MIDI キーボードをつなぎます。', 'Connects a MIDI keyboard.'],
  'kb.mode': ['鳴らし方', 'Keys play'],
  'kb.mode.keys': ['ふつう', 'Notes'],
  'kb.mode.keys.help': ['押した鍵盤の音がそのまま鳴ります。', 'The keys you press sound as they are.'],
  'kb.mode.arp': ['アルペジオ', 'Arpeggio'],
  'kb.mode.arp.help': ['押さえた鍵盤の音を、テンポに合わせて 1 音ずつ鳴らします。', 'The keys you hold are played one at a time, in time with the tempo.'],
  'kb.mode.clip': ['クリップ', 'Clip'],
  'kb.mode.clip.help': ['鍵盤を押さえているあいだ、ピアノロールに書いたフレーズをくり返します。押した鍵盤に合わせて高さが変わります。', 'While a key is held, the phrase drawn in the piano roll plays over and over, moved to the key you press.'],
  'kb.drawer.arp': ['アルペジオの設定', 'Arpeggio settings'],
  'kb.drawer.clip': ['クリップを編集', 'Edit the clip'],
  'kb.drawer.arp.short': ['設定', 'Settings'],
  'kb.drawer.clip.short': ['編集', 'Edit'],
  'kb.arp.tip': ['和音を押さえたままにしてみましょう。順番や速さは上の設定で変えられます。', 'Hold down a chord. Change the order and the speed in the settings above.'],
  'kb.clip.tip': ['鍵盤を押さえているあいだ、フレーズがくり返されます。ピアノロールで音を書き換えてみましょう。', 'Hold a key and the phrase plays over and over. Try changing its notes in the piano roll.'],
  'kb.arp.hold': ['「ホールド」をオンにすると、手を離しても鳴り続けます。', 'Switch on Hold to keep it playing after you let go.'],
  'kb.wheel.bend': ['ベンド', 'Bend'],
  'kb.wheel.mod': ['MOD', 'Mod'],
  'clip.title': ['クリップ', 'Clip'],
  'clip.roll': ['ピアノロール', 'Piano roll'],
  'clip.play': ['鳴らす', 'Play'],
  'clip.stop': ['止める', 'Stop'],
  'clip.length': ['長さ', 'Length'],
  'clip.bars': ['{n} 小節', '{n} bar(s)'],
  'clip.beats': ['{n} 拍', '{n} beats'],
  'clip.grid': ['マス目', 'Grid'],
  'clip.velocity': ['強さ', 'Velocity'],
  'clip.delete': ['消す', 'Delete'],
  'clip.clear': ['すべて消す', 'Clear all'],
  'clip.selected': ['{n} 個の音を選択中', '{n} note(s) selected'],
  'clip.newNotes': ['次に書く音', 'New notes'],
  'clip.slots': ['クリップ', 'Clips'],
  'clip.slotN': ['クリップ {n}', 'Clip {n}'],
  'clip.hint': [
    '空いたマスを押すと音を書けます。音をドラッグで移動、右端で長さ、ダブルクリックで消去。Shift＋ドラッグでまとめて選択。',
    'Press an empty cell to add a note. Drag a note to move it, its right end to resize it, double-click to remove it. Shift + drag selects.',
  ],
  'kb.midi': ['MIDI', 'MIDI'],
  'kb.midi.on': ['MIDI キーボードがつながりました', 'MIDI keyboard connected'],
  'kb.midi.none': ['MIDI 機器が見つかりません。つないでからもう一度押してください。', 'No MIDI device found. Connect one and press again.'],
  'kb.midi.denied': ['このブラウザでは MIDI を使えません。', 'MIDI is not available in this browser.'],

  // Displays
  'hint.wt': ['上下にドラッグすると、波形の位置が動きます。', 'Drag up or down to move through the wavetable.'],
  'hint.filterDisplay': [
    '点をドラッグ：左右でカットオフ、上下でレゾナンス。曲線は「どの高さの音をどれだけ通すか」を表します。',
    'Drag the dot: left and right is cutoff, up and down is resonance. The curve shows how much of each pitch gets through.',
  ],
  'hint.envDisplay': [
    '点をドラッグして形を変えられます。動く点は、いま鳴っている音がどこにいるかを示します。',
    'Drag the points to reshape it. The moving dot shows where the sounding note is right now.',
  ],
  'hint.lfoDisplay': [
    '右端の「描く」を選ぶと形を描けます。点をドラッグで移動、ダブルクリックで点の追加と削除、線をドラッグでカーブ。',
    'Choose "Draw" to make your own shape: drag points, double-click to add or remove one, drag a line to bend it.',
  ],

  // Guide
  'tour.title': ['はじめてガイド', 'First steps'],
  'tour.skip': ['ガイドを終える', 'End the guide'],
  'tour.next': ['次へ', 'Next'],
  'tour.back': ['戻る', 'Back'],
  'tour.done': ['終わる', 'Finish'],
  'tour.did': ['できました', 'Done'],
  'tour.step': ['{n} / {total}', '{n} of {total}'],
  'tour.1.title': ['まず聴いてみる', 'Listen first'],
  'tour.1.body': [
    '「聴く」を押すと、短いフレーズがくり返し流れます。下の鍵盤や、パソコンの Z X C V のキーでも弾けます。',
    'Press Listen to loop a short phrase. You can also play the keyboard below, or the Z X C V keys.',
  ],
  'tour.2.title': ['音の流れを見る', 'Follow the flow'],
  'tour.2.body': [
    'このボードが音の全体像です。線が音の通り道で、スイッチの入ったノードを通って出力まで届きます。音が流れている線は濃く光ります。',
    'This board is the whole sound. The line is the path the sound takes through every node that is switched on, ending at the output. It brightens where sound is flowing.',
  ],
  'tour.3.title': ['音のもとを変える', 'Change the raw tone'],
  'tour.3.body': [
    'オシレーター A の設定を開きました。「波形の位置」を動かすと、波の形と一緒に音色が変わります。',
    'Oscillator A is open. Move "Wave position": the tone changes with the shape of the wave.',
  ],
  'tour.4.title': ['フィルターで削る', 'Carve with the filter'],
  'tour.4.body': [
    '「カットオフ」を下げると高い成分が削られて、音がこもります。上の図の「入る音」と「出る音」を見比べてみてください。',
    'Lower "Cutoff" to remove the highs and darken the sound. Compare "Sound in" and "Sound out" in the picture above.',
  ],
  'tour.5.title': ['音量の形をつくる', 'Shape the loudness'],
  'tour.5.body': [
    'アンプは音量の時間変化を決めます。図の点をドラッグして、立ち上がり（アタック）や余韻（リリース）を変えてみましょう。',
    'The amp sets how loudness changes over time. Drag the points to change the start (attack) and the tail (release).',
  ],
  'tour.6.title': ['スライダーを自動で動かす', 'Make a slider move by itself'],
  'tour.6.body': [
    '「うごきを足す」から LFO を選び、開いた画面で「フィルター 1」の「カットオフ」につなぎます。ボードでは、動かされているノードに色のタグが付きます。',
    'Choose LFO from "Add movement", then connect it to Filter 1\'s Cutoff. On the board, a coloured tag appears on the node being moved.',
  ],
  'tour.7.title': ['エフェクトを足す', 'Add an effect'],
  'tour.7.body': [
    '下に並んでいるエフェクトのスイッチを入れると、音の流れに加わります。リバーブで試してみましょう。',
    'Switch on one of the effects waiting below and it joins the flow. Try the reverb.',
  ],
  'tour.8.title': ['できた音を共有する', 'Share what you made'],
  'tour.8.body': [
    '「共有」を押すと、この音色を再現できるリンクが作れます。左上の「音色」から、ほかの音も試せます。',
    'Press Share to get a link that recreates this sound. Try other sounds from "Sound" at the top left.',
  ],

  // Serum 2 export
  'serum.title': ['Serum 2 用に書き出す', 'Export for Serum 2'],
  'serum.intro': [
    'いまの音色を Serum 2 のプリセット（.SerumPreset）に変換します。seosynth と Serum は別のシンセなので、同じ音にはなりません。スライダーの位置、つながり、エフェクトの順番を、できる範囲で移し替えます。',
    'Converts the current sound into a Serum 2 preset (.SerumPreset). seosynth and Serum are different synths, so it will not sound identical: slider positions, connections and the effect order are carried over as far as they can be.',
  ],
  'serum.caveat': [
    'この機能はベータ版です。.SerumPreset は公開されていない形式で、コミュニティの解析結果と、Serum 2 で保存されたプリセットの中身をもとに書き出しています。',
    'This feature is in beta. The .SerumPreset format is not published; this export follows what the community has worked out and what presets saved by Serum 2 contain.',
  ],
  'serum.save': ['プリセットをダウンロード', 'Download the preset'],
  'serum.where': [
    '{name} を Serum 2 のプリセットフォルダ（Serum 2 Presets/Presets/User など）に入れるか、Serum 2 のメニューから読み込みます。ウェーブテーブルはプリセットの中に入っているので、別に入れる必要はありません。',
    'Put {name} into your Serum 2 preset folder (for example Serum 2 Presets/Presets/User), or load it from Serum 2\'s menu. The wavetables are inside the preset, so there is nothing else to install.',
  ],
  'serum.notes': ['変換メモ', 'Conversion notes'],
  'serum.notes.none': ['すべての設定を移し替えられました。', 'Everything was carried over.'],
  'serum.note.noise': [
    'ノイズ（{detail}）は Serum のホワイトノイズにしています。Serum 側で近いノイズを選び直してください。',
    'The noise ({detail}) became Serum\'s white noise. Pick the closest noise in Serum.',
  ],
  'serum.note.filterType': ['{detail} は、近そうな Serum のフィルターを推定で指定しています。', '{detail}: the closest Serum filter type was guessed.'],
  'serum.note.warpApprox': ['{detail} は Serum の近いワープで代用しています。', '{detail} is approximated by the nearest Serum warp.'],
  'serum.note.warpDropped': ['{detail} のワープは移し替えていません。', '{detail}: this warp mode was not carried over.'],
  'serum.note.modDropped': ['つながり「{detail}」は Serum 側の行き先が特定できず、移し替えていません。', 'Connection "{detail}" was not carried over: its Serum destination is unknown.'],
  'serum.note.fxDropped': ['{detail} は Serum 側の対応が確認できていないため、移し替えていません。', '{detail} was not carried over: its Serum counterpart is not confirmed.'],
  'serum.note.quality': ['音質（オーバーサンプリング）は移し替えていません。Serum の設定で選んでください。', 'Quality (oversampling) was not carried over: pick it in Serum\'s settings.'],
  'serum.note.modCurve': ['つながり「{detail}」の曲げは移し替えていません（Serum 側の単位が未確認です）。', 'Connection "{detail}": its curve was not carried over (Serum\'s unit is not confirmed).'],
  'serum.note.modAux': ['つながり「{detail}」の「強さを決めるもの」は Serum に対応するソースがなく、移し替えていません。', 'Connection "{detail}": what scales it has no Serum source, so it was not carried over.'],
  'serum.note.lfoChaos': ['{detail} は Serum のカオス LFO（Lorenz／Rössler）にしています。動く速さと出だしは少し違います。', '{detail} became Serum\'s own chaos LFO (Lorenz or Rössler); its speed and starting point differ a little.'],
  'serum.note.lfoRandom': ['{detail} は Serum のランダム LFO（RandomSH）にしています。出てくる値の並びは同じになりません。', '{detail} became Serum\'s random LFO (RandomSH); the values it picks will not be the same.'],
  'serum.note.lfoSmooth': ['{detail} の「なめらかさ」は Serum の Smooth に同じ割合で移していますが、かかり方は少し違います。', '{detail}: smoothing became Serum\'s Smooth at the same percentage, which rounds the shape a little differently.'],
  'serum.note.portamento': ['グライドの時間は、Serum 側の単位が確認できていないため、ずれることがあります。Serum で聞いて合わせてください。', 'Glide: Serum\'s unit for the time is not confirmed, so it may differ. Check it by ear in Serum.'],
  'serum.note.masterPitch': ['全体のピッチは移し替えていません。', 'The overall pitch offset was not carried over.'],
  'serum.note.clip': [
    'クリップのフレーズは Serum の最初のクリップに書き出しています。Serum で C3 を押すと、seosynth で基準の音を押したときと同じ高さになるように移調しています（Serum 側の基準は未確認です）。',
    'The clip\'s phrase is written to Serum\'s first clip, moved so that C3 in Serum plays what the root note plays here (Serum\'s reference note is not confirmed).',
  ],
  'serum.note.clipSlots': [
    'Serum の 12 個のクリップに同じ番号で書き出していますが、どれを鳴らすかと鍵盤での切り替えは移し替えていません。Serum で選び直してください。',
    'Each clip is written to Serum\'s clip of the same number, but which one plays and switching by key were not carried over. Pick them again in Serum.',
  ],
  'serum.note.clipOnce': ['クリップの「1 回だけ」は移し替えていません。Serum ではくり返し鳴ります。', 'Playing the clip once was not carried over: it loops in Serum.'],
  'serum.note.arp': [
    'Serum のアルペジエーターをオンにしていますが、速さ・順番・オクターブ・長さは移し替えていません。Serum 側で合わせてください。',
    'Serum\'s arpeggiator is switched on, but its rate, order, octaves and gate were not carried over: set them in Serum.',
  ],
  'serum.note.distApprox': ['ディストーションの {detail} は Downsample で代用しています。', 'Distortion {detail} is approximated by Downsample.'],
  'serum.note.delayLong': ['8 小節のディレイは Serum の最長（4 小節）にしています。', 'An 8-bar delay was shortened to Serum\'s longest (4 bars).'],
  'serum.note.split': [
    '分岐は Serum 側の配線の書き方が確認できていないため、道 A → 道 B の順に 1 本に並べています。',
    'The split was laid out as one row (lane A, then lane B): how Serum stores parallel routing is not confirmed.',
  ],
  'serum.note.filter2Routing': [
    'Serum の 2 つのフィルターは並列にしかつなげないため、直列のフィルター 1・2 は並列にしています。音が変わるので、Serum で確かめてください。',
    'Serum\'s two filters only run side by side, so filters 1 and 2 in series became parallel. This changes the sound: check it in Serum.',
  ],
  'serum.note.reverbDecay': ['Plate リバーブの長さは Serum ではサイズで決まるため、「長さ」は移し替えていません。', 'Plate reverb: Serum sets its length by size, so the decay was not carried over.'],
};

// Nodes on the signal path: [name, what it does, longer explanation].
/** Nodes: [name, role, explanation]. */
const NODE: Record<string, [Pair, Pair, Pair]> = {
  clip: [
    ['クリップ', 'Clip'],
    ['鍵盤を押さえているあいだ、書いたフレーズをくり返します。', 'Plays a drawn phrase over and over while a key is held.'],
    [
      'クリップシーケンサーは、ピアノロールに書いた短いフレーズを、鍵盤を押さえているあいだくり返し鳴らします。押す鍵盤を変えると、フレーズの高さが変わります。',
      'The clip sequencer plays a short phrase drawn in a piano roll over and over while a key is held. Press another key and the phrase moves to it.',
    ],
  ],
  arp: [
    ['アルペジエーター', 'Arpeggiator'],
    ['押さえた鍵盤の音を、テンポに合わせて 1 音ずつ鳴らします。', 'Plays the keys you hold one at a time, in time with the tempo.'],
    [
      'アルペジエーターは、押さえた和音をばらして順番に鳴らします。和音を押さえておくだけで、フレーズのように聞こえます。',
      'The arpeggiator breaks the chord you hold into single notes and plays them in turn, so holding a chord already sounds like a phrase.',
    ],
  ],
  oscA: [
    ['オシレーター A', 'Oscillator A'],
    ['波形をくり返して音を出す', 'Repeats a waveform to make a tone'],
    [
      'オシレーターは音の出発点です。ウェーブテーブルは少しずつ形の違う波形を束ねたもので、「波形の位置」を動かすと音色がなめらかに変わります。',
      'An oscillator is where the sound starts. A wavetable is a stack of slightly different waveforms; moving "Wave position" morphs the tone.',
    ],
  ],
  oscB: [
    ['オシレーター B', 'Oscillator B'],
    ['2 つ目の音を重ねる', 'Layers a second tone'],
    [
      '2 つ目のオシレーターです。A と違う波形やオクターブを重ねると、厚みや動きが出ます。',
      'A second oscillator. Layer a different waveform or octave on top of A for thickness and motion.',
    ],
  ],
  oscC: [
    ['オシレーター C', 'Oscillator C'],
    ['3 つ目の音を重ねる', 'Layers a third tone'],
    [
      '3 つ目のオシレーターです。A・B と別の波形を重ねて、さらに厚みを出せます。FM・AM・RM のワープでは A の音で変調されます。',
      'A third oscillator to layer yet another waveform. Its FM, AM and RM warps are driven by oscillator A.',
    ],
  ],
  sub: [
    ['サブ', 'Sub'],
    ['低い音で支える', 'Adds weight underneath'],
    ['メインの音の下で鳴るシンプルな波形です。オクターブを下げて、低音の土台を足します。', 'A simple waveform under the main tone, usually an octave or two down, for a solid low end.'],
  ],
  noise: [
    ['ノイズ', 'Noise'],
    ['ザラつきや空気感を足す', 'Adds breath and grit'],
    ['音程のない「ザー」という音です。アタックの息づかいや、風のような質感を足せます。', 'Noise has no pitch. Use it for breathy attacks or wind-like texture.'],
  ],
  filter: [
    ['フィルター 1', 'Filter 1'],
    ['音を削って明るさを変える', 'Carves the tone: bright or dark'],
    [
      '入ってきた音の一部の高さを削ります。ローパスはカットオフより上を削るので、下げるほどこもり、上げるほど明るくなります。',
      'Removes part of the spectrum. A low-pass removes everything above the cutoff: lower is darker, higher is brighter.',
    ],
  ],
  filter2: [
    ['フィルター 2', 'Filter 2'],
    ['もう 1 段、音を削る', 'A second filter'],
    [
      '2 つ目のフィルターです。「直列」ではフィルター 1 を通った音をさらに削り、2 つを組み合わせた形を作れます。「並列」ではフィルター 1 と横に並び、音源ごとにどちらを通すかを選べます（音源の設定で選びます）。',
      'A second filter. In series it shapes what leaves filter 1 again, combining the two. In parallel it sits beside filter 1 and each source picks which one it goes through (in that source\'s settings).',
    ],
  ],
  amp: [
    ['アンプ', 'Amp'],
    ['音量の時間変化をつくる', 'Shapes loudness over time'],
    [
      '鍵盤を押してから離すまでの、音量の変化を決めます。アタックを長くするとふわっと立ち上がり、リリースを長くすると余韻が残ります。',
      'Sets how loudness changes from key press to release. A long attack fades in softly; a long release leaves a tail.',
    ],
  ],
  split: [
    ['分岐', 'Split'],
    ['音を 2 つの道に分ける', 'Divides the sound into two lanes'],
    [
      'ここで音を 2 つの道に分け、それぞれ別のエフェクトを通してから、もう一度まとめます。分け方を変えると、低音だけ・高音だけ、中央だけ・左右だけにエフェクトをかけられます。道が空のあいだは、音は変わりません。',
      'The sound divides into two lanes here, each with its own effects, and is mixed again afterwards. Change how it is divided to treat only the lows or highs, or only the centre or the sides. While the lanes are empty the sound is unchanged.',
    ],
  ],
  out: [
    ['出力', 'Output'],
    ['最後に聞こえる音', 'What you finally hear'],
    ['最終的な音量と、いま出ている音の波形・成分を表示します。メーターが赤くなるときは音量を下げてください。', 'The final volume, with the waveform and spectrum of what you hear. If the meter turns red, turn it down.'],
  ],
};

const MOVER_ABOUT: Record<string, Pair> = {
  lfo: [
    'LFO はゆっくりくり返す波で、つないだスライダーを周期的に揺らします。音量ならトレモロ、ピッチならビブラート、カットオフならワウのような効果になります。',
    'An LFO is a slow repeating wave that wobbles the sliders it is connected to: tremolo on level, vibrato on pitch, a wah on cutoff.',
  ],
  env: [
    'エンベロープは、鍵盤を押すたびに「上がって、下がって、保って、消える」動きを一度だけ出します。つないだスライダーがその形で動きます。',
    'An envelope makes one rise-and-fall shape each time you press a key. The sliders it is connected to follow that shape.',
  ],
  macro: [
    'マクロは自分で動かすスライダーです。複数のスライダーにつなぐと、ひとつ動かすだけで音色を大きく変えられます。',
    'A macro is a slider you move yourself. Connect it to several sliders to change the whole sound with one move.',
  ],
  play: [
    '弾き方に合わせてスライダーを動かします。たとえば「弾く強さ」をカットオフにつなぐと、強く弾くほど明るい音になります。',
    'Moves sliders according to how you play. Connect "Velocity" to the cutoff and harder notes sound brighter.',
  ],
};

// A few plain words under the technical name of the most important sliders.
const PLAIN: Record<string, Pair> = {
  'filter.cutoff': ['音の明るさ', 'brightness'],
  'filter.res': ['クセの強さ', 'sharpness'],
  'osc.unison': ['重ねる数', 'copies'],
  'osc.detune': ['重ねた音のずれ', 'spread of the copies'],
  'env.attack': ['立ち上がり', 'fade in'],
  'env.decay': ['減衰', 'fall'],
  'env.sustain': ['保つ高さ', 'held level'],
  'env.release': ['余韻', 'tail'],
  'lfo.rate': ['1 秒に何回', 'times per second'],
};

/** Parameters: [label, help]. */
const PARAM: Record<string, [Pair, Pair]> = {
  'master.volume': [['全体の音量', 'Volume'], ['最終的な音の大きさ。', 'Final output level.']],
  'master.pitch': [['全体のピッチ', 'Pitch'], ['全体の音の高さ（半音単位）。LFOをつなぐとビブラートになります。', 'Overall pitch in semitones. Connect an LFO for vibrato.']],
  'master.voices': [['同時発音数', 'Voices'], ['同時に鳴らせる音の数。少なくすると処理が軽くなります。', 'How many notes can sound at once. Fewer is lighter on the CPU.']],
  'master.mono': [['モノ', 'Mono'], ['一度に1音だけ鳴らします。ベースやリードに向いています。', 'One note at a time. Good for bass and lead lines.']],
  'master.legato': [['レガート', 'Legato'], ['前の音を離さずに次を弾くと、音を切らずになめらかにつなぎます（モノのとき有効）。', 'When notes overlap, glide into the next one without restarting it (mono mode).']],
  'master.porta': [['グライド', 'Glide'], ['音程が次の音へすべるように移る時間。', 'Time for the pitch to slide to the next note.']],
  'master.portaAlways': [['いつもグライド', 'Always glide'], ['オン：いつもグライド。オフ：音を重ねて弾いたときだけ。', 'On: always glide. Off: only when notes overlap.']],
  'master.bendRange': [['ベンドの幅', 'Bend range'], ['ピッチベンドで動く音程の幅。', 'How far the pitch wheel bends.']],
  'master.quality': [
    ['音質', 'Quality'],
    [
      '声を何倍の細かさで計算するか。2x・4x にすると、ワープやドライブで出る高すぎる倍音が折り返して濁るのを防げます。そのぶん計算が重くなります（2x でおよそ 2 倍、4x で 4 倍）。',
      'How many times finer the voices are calculated. At 2x or 4x, harmonics too high to play (from warps and drive) no longer fold back as harsh noise. It costs more: about twice as much at 2x and four times at 4x.',
    ],
  ],
  'master.bpm': [['テンポ', 'Tempo'], ['テンポ（BPM）。アルペジエーター、同期したLFOやディレイ、デモ演奏の速さに使われます。', 'Tempo in BPM, used by the arpeggiator, synced LFOs, the delay and the demo player.']],
  'master.velSens': [['弾く強さの効き', 'Velocity'], ['鍵盤を弾く強さが音量に影響する度合い。0%で常に同じ音量。', 'How much playing harder makes it louder. 0% means always the same.']],
  macro: [['マクロ', 'Macro'], ['自由に使えるスライダー。複数のスライダーにつなぐと、ひとつでまとめて動かせます。', 'A free slider. Connect it to several sliders to move them all at once.']],

  'osc.on': [['電源', 'On'], ['このオシレーターを鳴らすかどうか。', 'Switch this oscillator on or off.']],
  'osc.wt': [['ウェーブテーブル', 'Wavetable'], ['波形の束（ウェーブテーブル）を選びます。音色の方向性がここで決まります。', 'Pick the wavetable: a stack of waveforms. This sets the basic character.']],
  'osc.pos': [['波形の位置', 'Wave position'], ['ウェーブテーブルの中のどの波形を鳴らすか。動かすと音色がなめらかに変わります。LFOやENVをつなぐのが定番。', 'Which waveform of the table plays. Moving it morphs the tone; a favourite target for LFOs and envelopes.']],
  'osc.level': [['音量', 'Level'], ['このオシレーターの音量。', 'Volume of this oscillator.']],
  'osc.pan': [['左右の位置', 'Pan'], ['左右の位置。', 'Left / right position.']],
  'osc.oct': [['オクターブ', 'Octave'], ['音の高さをオクターブ単位で上下します。', 'Shifts the pitch by octaves.']],
  'osc.semi': [['セミトーン', 'Semi'], ['音の高さを半音単位で上下します。+7で5度上。', 'Shifts the pitch by semitones. +7 is a fifth up.']],
  'osc.fine': [['ファイン', 'Fine'], ['音の高さの微調整（セント）。AとBを少しずらすと厚みが出ます。', 'Fine tuning in cents. Slightly detuning A against B sounds thicker.']],
  'osc.coarse': [['コース', 'Coarse'], ['なめらかに変えられる音程。エンベロープで大きく動かすとキックやレーザー音に。', 'Continuous pitch offset. Sweep it with an envelope for kicks and laser zaps.']],
  'osc.unison': [['ユニゾン', 'Unison'], ['同じ音を重ねる数。増やすと分厚く広がりのある音になります。', 'How many copies play together. More copies sound thicker and wider.']],
  'osc.detune': [['デチューン', 'Detune'], ['重ねた音どうしの音程のずれ。大きいほどうねりが強くなります。', 'How far the unison copies are detuned. More gives a stronger shimmer.']],
  'osc.blend': [['ブレンド', 'Blend'], ['中央の音と、ずらした音のバランス。', 'Balance between the centre voice and the detuned ones.']],
  'osc.width': [['広がり', 'Width'], ['重ねた音を左右に広げる量。', 'How far the unison copies spread left and right.']],
  'osc.phase': [['スタート位置', 'Start phase'], ['波形のどこから鳴り始めるか。', 'Where in the waveform each note starts.']],
  'osc.rand': [['スタートのばらつき', 'Random start'], ['鳴らすたびに開始位置をばらつかせる量。0%にすると毎回同じアタックになります。', 'Randomises the start position per note. At 0% every attack is identical.']],
  'osc.warp': [['ワープ', 'Warp'], ['波形を変形させる方法。Sync は鋭く、Bend は偏らせ、FM/AM/RM はもう一方のオシレーターで変調します。', 'How the waveform is bent. Sync is sharp, Bend skews it, FM/AM/RM use the other oscillator.']],
  'osc.warpAmt': [['ワープの量', 'Warp amount'], ['ワープのかかり具合。', 'How strongly the warp is applied.']],
  'osc.warp2': [['ワープ 2', 'Warp 2'], ['1 つ目のワープで変形した波形を、さらに変形させます。順番で音が変わります（Bend → Sync と Sync → Bend は別の音）。', 'Bends the waveform again after the first warp. The order matters: Bend then Sync is not Sync then Bend.']],
  'osc.warp2Amt': [['ワープ 2 の量', 'Warp 2 amount'], ['2 つ目のワープのかかり具合。', 'How strongly the second warp is applied.']],
  'osc.toFilter': [['フィルターを通す', 'Through the filters'], ['オンでフィルターを通ります。オフだとフィルターを迂回します。', 'On: goes through the filters. Off: bypasses them.']],
  'osc.filterSel': [['通すフィルター', 'Into filter'], ['フィルターが並列のとき、どちらに通すか。「両方」は半分ずつ両方に通して足します。', 'With the filters in parallel, which one this goes through. Both sends half into each and adds them.']],
  'osc.userTable': [['テーブルの種類', 'Table source'], ['内蔵のウェーブテーブルを鳴らすか、自分で作ったテーブルを鳴らすかを選びます。', 'Plays a built-in wavetable, or one you made yourself.']],

  'sub.on': [['電源', 'On'], ['サブオシレーターを鳴らすかどうか。', 'Switch the sub oscillator on or off.']],
  'sub.shape': [['波形', 'Shape'], ['サブの波形。Sine は丸く、Square や Saw は存在感が出ます。', 'Waveform of the sub. Sine is round; square and saw cut through more.']],
  'sub.oct': [['オクターブ', 'Octave'], ['メインの音から何オクターブ下（上）で鳴らすか。', 'Octaves below (or above) the played note.']],
  'sub.level': [['音量', 'Level'], ['サブの音量。', 'Volume of the sub.']],
  'sub.pan': [['左右の位置', 'Pan'], ['左右の位置。', 'Left / right position.']],
  'sub.toFilter': [['フィルターを通す', 'Through the filters'], ['オンでフィルターを通ります。', 'On: goes through the filters.']],
  'sub.filterSel': [['通すフィルター', 'Into filter'], ['フィルターが並列のとき、どちらに通すか。', 'With the filters in parallel, which one this goes through.']],

  'noise.on': [['電源', 'On'], ['ノイズを鳴らすかどうか。', 'Switch the noise on or off.']],
  'noise.type': [['種類', 'Type'], ['ノイズの種類。White は明るく、Pink・Brown は低め、Digital は粗く、Crackle はパチパチ。', 'Kind of noise: white is bright, pink and brown darker, digital is gritty, crackle pops.']],
  'noise.level': [['音量', 'Level'], ['ノイズの音量。', 'Volume of the noise.']],
  'noise.pan': [['左右の位置', 'Pan'], ['左右の位置。', 'Left / right position.']],
  'noise.tone': [['トーン', 'Tone'], ['ノイズの明るさ（Digital は粗さ、Crackle は密度）。', 'Brightness of the noise (grit for Digital, density for Crackle).']],
  'noise.toFilter': [['フィルターを通す', 'Through the filters'], ['オンでフィルターを通ります。', 'On: goes through the filters.']],
  'noise.filterSel': [['通すフィルター', 'Into filter'], ['フィルターが並列のとき、どちらに通すか。', 'With the filters in parallel, which one this goes through.']],

  'filter.on': [['電源', 'On'], ['フィルターを使うかどうか。オフにすると音はそのまま通ります。', 'Switch the filter on or off. When off the sound passes untouched.']],
  'filter.type': [['タイプ', 'Type'], ['フィルターの種類。LP は高音を削る、HP は低音を削る、BP は真ん中だけ通す。数字は削り方の急さ。', 'Kind of filter. LP removes highs, HP removes lows, BP keeps the middle. The number is how steep it is.']],
  'filter.cutoff': [['カットオフ', 'Cutoff'], ['この周波数を境に音を削ります。ローパスなら、下げるほどこもり、上げるほど明るくなります。', 'The frequency where the filter starts cutting. With a low-pass: lower is darker, higher is brighter.']],
  'filter.res': [['レゾナンス', 'Resonance'], ['カットオフ付近を強調します。上げるとクセのある鋭い音に。', 'Boosts the area around the cutoff. Higher is sharper and more nasal.']],
  'filter.drive': [['ドライブ', 'Drive'], ['フィルターの手前で音を歪ませて太くします。', 'Overdrives the sound going into the filter for a fatter tone.']],
  'filter.var': [['バリエーション', 'Variation'], ['バリエーション。タイプによって働きが変わります。Morph：LP→BP→HP、Formant：母音、Comb：こもり具合、Phaser：広がり。', 'Depends on the type. Morph: LP to BP to HP. Formant: vowel. Comb: damping. Phaser: spread.']],
  'filter.mix': [['ミックス', 'Mix'], ['フィルターを通した音と、通す前の音の割合。', 'Balance between filtered and unfiltered sound.']],
  'filter.keytrack': [['キー追従', 'Key tracking'], ['高い音を弾くほどカットオフも上がるようにします。100%で音程と同じだけ動きます。', 'Raises the cutoff for higher notes. At 100% it follows the pitch exactly.']],
  'filter.stereo': [['左右のずれ', 'Stereo offset'], ['左右でカットオフをずらして広がりを出します。', 'Offsets the cutoff between left and right for width.']],
  'filter.mode': [
    ['つなぎ方', 'Connection'],
    ['直列：フィルター 1 の後ろにつなぎます。並列：フィルター 1 の横に並べ、音源ごとにどちらを通すか選べます。', 'Series: after filter 1. Parallel: beside filter 1, and each source picks which one it goes through.'],
  ],

  'env.attack': [['アタック', 'Attack'], ['鍵盤を押してから最大になるまでの時間。長くするとふわっと立ち上がります。', 'Time from key press to full level. Longer fades in softly.']],
  'env.hold': [['ホールド', 'Hold'], ['最大のまま保つ時間。', 'Time it stays at full level.']],
  'env.decay': [['ディケイ', 'Decay'], ['最大からサステインの高さまで下がる時間。短いと歯切れのよい音に。', 'Time to fall from full level to the sustain level. Short is plucky.']],
  'env.sustain': [['サステイン', 'Sustain'], ['鍵盤を押している間、保たれる高さ。0%にすると押し続けても消えていきます。', 'Level held while the key is down. At 0% the note dies away even if held.']],
  'env.release': [['リリース', 'Release'], ['鍵盤を離してから消えるまでの時間。長いと余韻が残ります。', 'Time to fade out after the key is released. Longer leaves a tail.']],
  'env.atkCurve': [['アタックのカーブ', 'Attack curve'], ['アタックの曲がり方。＋で最初に速く、－で最初はゆっくり。', 'Bend of the attack. Positive is fast first, negative starts slowly.']],
  'env.decCurve': [['ディケイのカーブ', 'Decay curve'], ['ディケイの曲がり方。＋で最初に速く落ちる自然な減衰に。', 'Bend of the decay. Positive drops fast first, like a natural decay.']],
  'env.relCurve': [['リリースのカーブ', 'Release curve'], ['リリースの曲がり方。', 'Bend of the release.']],

  'lfo.shape': [
    ['波形', 'Shape'],
    [
      '揺れ方の形。「描く」を選ぶと自分で描けます。カオスの 2 つは、決まった形をくり返さず、似ているのに毎回少しずつ違う揺れ方をします（ローレンツは 2 つの山を行き来し、レスラーはらせんを描きながらときどき跳ねます）。速さはそのまま進む速さです。',
      'The shape of the wobble. Choose Draw to draw your own. The two chaos shapes never repeat exactly: they move in a similar way each time but never the same (Lorenz swings between two lobes, Rössler spirals and jumps now and then). The rate sets how fast they move.',
    ],
  ],
  'lfo.rate': [['速さ', 'Rate'], ['揺れる速さ（1秒間に何回か）。', 'How fast it cycles, in times per second.']],
  'lfo.sync': [['テンポに合わせる', 'Sync to tempo'], ['オンで速さをテンポ（音符の長さ）に合わせます。', 'On: the speed locks to the tempo, in note lengths.']],
  'lfo.div': [['1周の長さ', 'Cycle length'], ['1周の長さを音符で指定します。1/4 は4分音符、T は3連、. は付点。', 'Length of one cycle as a note value. T is triplet, a dot is dotted.']],
  'lfo.mode': [['モード', 'Mode'], ['Trig：弾くたびに最初から。Env：1回だけ動いて止まる（エンベロープのように使える）。Free：ずっと動き続ける。', 'Trig: restarts with each note. Env: runs once and stops, like an envelope. Free: never stops.']],
  'lfo.rise': [['だんだん強く', 'Fade in'], ['揺れがだんだん大きくなるまでの時間。遅れてかかるビブラートなどに。', 'Time for the wobble to fade in. Good for delayed vibrato.']],
  'lfo.delay': [['始まるまでの間', 'Delay'], ['揺れ始めるまでの待ち時間。', 'Wait before the wobble starts.']],
  'lfo.smooth': [['なめらかさ', 'Smoothing'], ['形の角を丸めます。', 'Rounds off sharp corners of the shape.']],
  'lfo.phase': [['スタート位置', 'Start phase'], ['形のどこから始めるか。カオスの形では、同じ位置からは毎回同じ動きになります。', 'Where in the shape it starts. For the chaos shapes, the same start always gives the same movement.']],

  'hyper.on': [['電源', 'On'], ['', '']],
  'hyper.rate': [['速さ', 'Rate'], ['重ねた音が揺れる速さ。', 'How fast the added voices drift.']],
  'hyper.detune': [['デチューン', 'Detune'], ['重ねた音の音程のずれ。', 'How far the added voices are detuned.']],
  'hyper.voices': [['ボイス数', 'Voices'], ['重ねる数。', 'How many voices are added.']],
  'hyper.mix': [['ミックス', 'Mix'], ['エフェクト音の量。', 'Amount of the effect.']],
  'hyper.dimSize': [['広がりのサイズ', 'Width size'], ['ディメンション（ステレオの広がり）の大きさ。', 'Size of the Dimension stereo widener.']],
  'hyper.dimMix': [['広がり', 'Width'], ['ディメンション。ステレオを広げる効果の量。', 'Amount of stereo widening.']],

  'dist.on': [['電源', 'On'], ['', '']],
  'dist.mode': [['タイプ', 'Type'], ['歪みの種類。Tube・Soft は温かく、Hard・Fold は激しく、Bitcrush・Downsample はローファイに。', 'Kind of distortion. Tube and Soft are warm, Hard and Fold aggressive, Bitcrush and Downsample lo-fi.']],
  'dist.drive': [['ドライブ', 'Drive'], ['歪みの強さ。', 'How hard it distorts.']],
  'dist.mix': [['ミックス', 'Mix'], ['歪ませた音と元の音の割合。', 'Balance between distorted and clean sound.']],
  'dist.filterMode': [['フィルター', 'Filter'], ['歪みの前（Pre）か後（Post）にフィルターをかけます。', 'Adds a filter before (Pre) or after (Post) the distortion.']],
  'dist.filterType': [['フィルターの種類', 'Filter kind'], ['フィルターの種類。', 'Kind of filter.']],
  'dist.filterFreq': [['フィルターの周波数', 'Filter frequency'], ['フィルターの周波数。', 'Filter frequency.']],
  'dist.filterQ': [['フィルターの鋭さ', 'Filter sharpness'], ['フィルターの鋭さ。', 'Filter sharpness.']],

  'flanger.on': [['電源', 'On'], ['', '']],
  'flanger.rate': [['速さ', 'Rate'], ['うねりの速さ。', 'Speed of the sweep.']],
  'flanger.depth': [['深さ', 'Depth'], ['うねりの深さ。', 'Depth of the sweep.']],
  'flanger.feedback': [['フィードバック', 'Feedback'], ['フィードバック。上げると金属的で強いクセが出ます。', 'More feedback sounds more metallic and resonant.']],
  'flanger.phase': [['左右のずれ', 'Stereo offset'], ['左右のうねりのずれ。', 'Offset of the sweep between left and right.']],
  'flanger.mix': [['ミックス', 'Mix'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'phaser.on': [['電源', 'On'], ['', '']],
  'phaser.rate': [['速さ', 'Rate'], ['うねりの速さ。', 'Speed of the sweep.']],
  'phaser.depth': [['深さ', 'Depth'], ['うねりの深さ。', 'Depth of the sweep.']],
  'phaser.freq': [['中心の周波数', 'Centre frequency'], ['うねりの中心となる高さ。', 'Centre of the sweep.']],
  'phaser.feedback': [['フィードバック', 'Feedback'], ['フィードバック。上げると効果が強くなります。', 'More feedback makes it more pronounced.']],
  'phaser.phase': [['左右のずれ', 'Stereo offset'], ['左右のうねりのずれ。', 'Offset of the sweep between left and right.']],
  'phaser.mix': [['ミックス', 'Mix'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'chorus.on': [['電源', 'On'], ['', '']],
  'chorus.rate': [['速さ', 'Rate'], ['揺れの速さ。', 'Speed of the wobble.']],
  'chorus.delay1': [['ディレイ1', 'Delay 1'], ['1つ目の遅らせる時間。', 'First delay time.']],
  'chorus.delay2': [['ディレイ2', 'Delay 2'], ['2つ目の遅らせる時間。', 'Second delay time.']],
  'chorus.depth': [['深さ', 'Depth'], ['揺れの深さ。', 'Depth of the wobble.']],
  'chorus.feedback': [['フィードバック', 'Feedback'], ['フィードバック。上げると効果が強くなります。', 'More feedback makes it more pronounced.']],
  'chorus.lpf': [['高音を削る', 'Low-pass'], ['エフェクト音の高音を削ります。', 'Removes highs from the effect.']],
  'chorus.mix': [['ミックス', 'Mix'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'delay.on': [['電源', 'On'], ['', '']],
  'delay.sync': [['テンポに合わせる', 'Sync to tempo'], ['オンで、やまびこの間隔をテンポに合わせます。', 'On: the echo time locks to the tempo.']],
  'delay.timeL': [['やまびこの間隔（左）', 'Echo time (left)'], ['左のやまびこが返ってくるまでの時間。', 'Echo time on the left.']],
  'delay.timeR': [['やまびこの間隔（右）', 'Echo time (right)'], ['右のやまびこが返ってくるまでの時間。', 'Echo time on the right.']],
  'delay.divL': [['やまびこの間隔（左）', 'Echo time (left)'], ['左のやまびこの間隔（音符）。', 'Echo time on the left as a note value.']],
  'delay.divR': [['やまびこの間隔（右）', 'Echo time (right)'], ['右のやまびこの間隔（音符）。', 'Echo time on the right as a note value.']],
  'delay.link': [['左右を同じにする', 'Same time left and right'], ['オンで左右を同じ時間にします。', 'On: left and right use the same time.']],
  'delay.feedback': [['くり返し', 'Feedback'], ['フィードバック。やまびこがくり返す回数。上げるほど長く続きます。', 'How many times the echo repeats. Higher lasts longer.']],
  'delay.mode': [['モード', 'Mode'], ['Normal：左右それぞれ。PingPong：左右に行ったり来たり。Tap：左に1回、右にくり返し。', 'Normal: each side on its own. PingPong: bounces left and right. Tap: one echo left, repeats right.']],
  'delay.filterFreq': [['やまびこの音色', 'Echo tone'], ['やまびこの音色の中心。くり返すたびにこの帯域に寄っていきます。', 'Tone of the echoes. Each repeat narrows towards this frequency.']],
  'delay.filterQ': [['音色のしぼり', 'Tone focus'], ['上げるほど、やまびこが細い音になっていきます。', 'Higher makes the echoes thinner.']],
  'delay.mix': [['ミックス', 'Mix'], ['やまびこの音量。', 'Level of the echoes.']],

  'comp.on': [['電源', 'On'], ['', '']],
  'comp.threshold': [['しきい値', 'Threshold'], ['スレッショルド。この音量を超えた分を抑えます。下げるほど強くかかります。', 'Sound above this level is turned down. Lower compresses more.']],
  'comp.ratio': [['レシオ', 'Ratio'], ['抑える強さ。4:1なら、超えた分を1/4に。', 'How strongly it turns down. 4:1 lets a quarter of the excess through.']],
  'comp.attack': [['アタック', 'Attack'], ['抑え始めるまでの速さ。', 'How fast it reacts.']],
  'comp.release': [['リリース', 'Release'], ['抑えるのをやめるまでの速さ。', 'How fast it lets go.']],
  'comp.gain': [['持ち上げ', 'Make-up gain'], ['抑えて小さくなった分を持ち上げます。', 'Makes up for the level lost by compressing.']],
  'comp.multiband': [['マルチバンド', 'Multiband'], ['低・中・高の3つに分けて別々に抑えます。派手で密度の高い音に。', 'Splits into low, mid and high and compresses each. Dense and bright.']],
  'comp.mix': [['ミックス', 'Mix'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'reverb.on': [['電源', 'On'], ['', '']],
  'reverb.mode': [['タイプ', 'Type'], ['Plate：明るく密な響き。Hall：広いホールの響き。', 'Plate: bright and dense. Hall: a large room.']],
  'reverb.size': [['サイズ', 'Size'], ['空間の広さ。', 'Size of the space.']],
  'reverb.decay': [['長さ', 'Decay'], ['響きが消えるまでの長さ。', 'How long the reverb rings.']],
  'reverb.predelay': [['プリディレイ', 'Pre-delay'], ['プリディレイ。響きが始まるまでの間。少し空けると元の音がはっきりします。', 'Gap before the reverb starts. A little keeps the dry sound clear.']],
  'reverb.lowcut': [['低音を削る', 'Low cut'], ['響きの低音を削ります。', 'Removes lows from the reverb.']],
  'reverb.highcut': [['高音を削る', 'High cut'], ['響きの高音を削ります。', 'Removes highs from the reverb.']],
  'reverb.damp': [['高音の減り', 'Damping'], ['響きの高音が先に消えていく度合い。', 'How quickly the highs of the tail die away.']],
  'reverb.width': [['広がり', 'Width'], ['響きの左右の広がり。', 'Stereo width of the reverb.']],
  'reverb.mix': [['ミックス', 'Mix'], ['響きの量。', 'Amount of reverb.']],

  'eq.on': [['電源', 'On'], ['', '']],
  'eq.lowType': [['低音の形', 'Low band shape'], ['Shelf：それより下を全体に。Peak：その付近だけ。HP：それより下をカット。', 'Shelf: everything below. Peak: just around it. HP: cut everything below.']],
  'eq.lowFreq': [['低音の周波数', 'Low frequency'], ['低域の周波数。', 'Frequency of the low band.']],
  'eq.lowQ': [['低音の鋭さ', 'Low sharpness'], ['低域の鋭さ。', 'Sharpness of the low band.']],
  'eq.lowGain': [['低音', 'Lows'], ['低域を上げ下げする量。', 'Boost or cut of the low band.']],
  'eq.highType': [['高音の形', 'High band shape'], ['Shelf：それより上を全体に。Peak：その付近だけ。LP：それより上をカット。', 'Shelf: everything above. Peak: just around it. LP: cut everything above.']],
  'eq.highFreq': [['高音の周波数', 'High frequency'], ['高域の周波数。', 'Frequency of the high band.']],
  'eq.highQ': [['高音の鋭さ', 'High sharpness'], ['高域の鋭さ。', 'Sharpness of the high band.']],
  'eq.highGain': [['高音', 'Highs'], ['高域を上げ下げする量。', 'Boost or cut of the high band.']],

  'fxfilter.on': [['電源', 'On'], ['', '']],
  'fxfilter.type': [['タイプ', 'Type'], ['フィルターの種類。', 'Kind of filter.']],
  'fxfilter.cutoff': [['カットオフ', 'Cutoff'], ['全体の音を削る周波数。', 'Cutoff applied to the whole sound.']],
  'fxfilter.res': [['レゾナンス', 'Resonance'], ['カットオフ付近の強調。', 'Emphasis around the cutoff.']],
  'fxfilter.drive': [['ドライブ', 'Drive'], ['手前での歪み。', 'Overdrive into the filter.']],
  'fxfilter.var': [['バリエーション', 'Variation'], ['バリエーション。タイプによって働きが変わります。', 'Depends on the type.']],
  'fxfilter.mix': [['ミックス', 'Mix'], ['エフェクト音の割合。', 'Amount of the effect.']],

  'freqshift.on': [['電源', 'On'], ['', '']],
  'freqshift.shift': [
    ['ずらす量', 'Shift'],
    [
      'すべての周波数を同じ Hz だけ上（プラス）か下（マイナス）にずらします。倍音の並びがくずれるので、数 Hz ではうねり、大きくすると金属的な響きになります。',
      'Moves every frequency up (plus) or down (minus) by the same number of hertz. This breaks the harmonic series: a few hertz makes it swirl, more makes it metallic.',
    ],
  ],
  'freqshift.stereo': [['左右の差', 'Stereo'], ['右の音を左と逆の向きにずらしていきます。100% で右は真逆にずれ、大きく広がります。', 'Shifts the right channel the other way. At 100% it moves opposite to the left, for a wide sound.']],
  'freqshift.feedback': [['フィードバック', 'Feedback'], ['ずらした音をもう一度通して、階段のように何度もずらします。', 'Feeds the shifted sound back in, so it keeps stepping up or down.']],
  'freqshift.mix': [['ミックス', 'Mix'], ['ずらした音の割合。50% で元の音と重なり、うねりが出ます。', 'Amount of shifted sound. At 50% it mixes with the original and beats against it.']],

  'utility.on': [['電源', 'On'], ['', '']],
  'utility.gain': [['音量', 'Gain'], ['ここを通る音の大きさを dB で上げ下げします。', 'Raises or lowers the level passing through, in dB.']],
  'utility.pan': [['左右の位置', 'Pan'], ['音を左（マイナス）か右（プラス）に寄せます。まん中では何も変わりません。', 'Moves the sound left (minus) or right (plus). The middle leaves it as it is.']],
  'utility.width': [['広がり', 'Width'], ['0% でモノラル、100% でそのまま、200% で左右の差を 2 倍にします。', '0% is mono, 100% leaves it as it is, 200% doubles the difference between left and right.']],
  'utility.monoBass': [['低音をまん中に', 'Mono bass'], ['下の周波数より低い音から左右の差をなくし、低音をまん中にまとめます。', 'Removes the stereo difference below the frequency underneath, keeping the bass in the centre.']],
  'utility.monoFreq': [['まん中にする高さ', 'Mono below'], ['これより低い音をまん中にまとめます。', 'Sound below this is kept in the centre.']],

  'arp.on': [['電源', 'On'], ['アルペジエーターを使うかどうか。オフにすると、押さえた音がそのまま鳴ります。', 'Switch the arpeggiator on or off. When off, the keys you hold sound as they are.']],
  'arp.mode': [['順番', 'Order'], ['押さえた音を鳴らす順番。上へ・下へ・上下、弾いた順、ランダム、または全部いっしょ（和音）。', 'The order the held notes are played in: up, down, up and down, as played, random, or all together (chord).']],
  'arp.div': [['1 音の長さ', 'Rate'], ['1 音ごとの間隔を音符で決めます。1/16 で 1 拍に 4 音です。', 'How far apart the notes are, as a note length. 1/16 plays four notes per beat.']],
  'arp.octaves': [['オクターブ', 'Octaves'], ['何オクターブ上まで続けて鳴らすか。2 にすると、押さえた音を 1 オクターブ上でもう一度鳴らします。', 'How many octaves the pattern climbs. At 2 the held notes are played again an octave up.']],
  'arp.gate': [['音の長さ', 'Gate'], ['1 音のうち音を鳴らしている長さ。短いと歯切れよく、100% で次の音とつながります。', 'How much of each step the note sounds. Short is crisp; at 100% each note runs into the next.']],
  'arp.swing': [['スウィング', 'Swing'], ['2 音目ごとに少し遅らせて、はねたリズムにします。', 'Delays every second note for a bouncy, shuffled rhythm.']],

  'clip.on': [['電源', 'On'], ['クリップシーケンサーを使うかどうか。オンのあいだはアルペジエーターより優先されます。', 'Switch the clip sequencer on or off. While on, it comes before the arpeggiator.']],
  'clip.root': [['基準の音', 'Root note'], ['この鍵盤を押すと、書いたとおりの高さで鳴ります。ほかの鍵盤では、その差だけ高さが変わります。', 'Pressing this key plays the clip as drawn; other keys move it up or down by the difference.']],
  'clip.loop': [['くり返す', 'Loop'], ['オン：押さえているあいだくり返します。オフ：1 回だけ鳴らします。', 'On: plays over and over while held. Off: plays once.']],
  'clip.slot': [['どのクリップ', 'Clip'], ['12 個のクリップのうち、鳴らして編集するもの。', 'Which of the 12 clips plays and is edited.']],
  'clip.keySwitch': [
    ['鍵盤で切り替え', 'Switch by key'],
    [
      'オンにすると、いちばん下のオクターブ（C1〜B1）の鍵盤がクリップ 1〜12 を選ぶボタンになります。弾きながらフレーズを切り替えられます。',
      'When on, the lowest octave (C1 to B1) picks clip 1 to 12 instead of playing, so you can change phrases while you play.',
    ],
  ],

  'split.mode': [['分け方', 'Divide by'], ['音を 2 つの道にどう分けるか。', 'How the sound is divided between the two lanes.']],
  'split.freq': [['分ける高さ', 'Crossover'], ['この高さより下が低音の道、上が高音の道に進みます。', 'Sound below this goes to the lows lane, sound above it to the highs lane.']],
  'split.balance': [
    ['まぜ具合', 'Balance'],
    ['2 つの道をまとめるときの割合。まん中で、分ける前と同じ音量になります。', 'How much of each lane goes into the mix. In the middle the level is the same as before the split.'],
  ],
};

/** Effects: [name, role]. */
const FX: Record<string, [Pair, Pair]> = {
  hyper: [['ハイパー', 'Hyper'], ['音を重ねて厚くする', 'Stacks copies for thickness']],
  dist: [['ディストーション', 'Distortion'], ['歪ませて荒々しく', 'Adds grit and bite']],
  flanger: [['フランジャー', 'Flanger'], ['シュワーっとうねる', 'A jet-like sweep']],
  phaser: [['フェイザー', 'Phaser'], ['ゆっくり色が変わる', 'A slow swirling colour']],
  chorus: [['コーラス', 'Chorus'], ['揺らして広げる', 'Wobbles and widens']],
  delay: [['ディレイ', 'Delay'], ['やまびこ', 'Echoes']],
  comp: [['コンプレッサー', 'Compressor'], ['音量の差をならす', 'Evens out the level']],
  reverb: [['リバーブ', 'Reverb'], ['部屋やホールの響き', 'Room and hall ambience']],
  eq: [['EQ', 'EQ'], ['低音と高音の調整', 'Adjusts lows and highs']],
  fxfilter: [['全体フィルター', 'Master filter'], ['全体にかけるフィルター', 'A filter on everything']],
  freqshift: [['周波数シフター', 'Frequency shifter'], ['周波数をずらして金属的に', 'Shifts frequencies for a metallic tone']],
  utility: [['ユーティリティ', 'Utility'], ['音量・左右・広がりの調整', 'Level, pan and width']],
};

/** Modulation sources: [name, what it does]. */
const SOURCE: Record<string, [Pair, Pair]> = {
  none: [['なし', 'None'], ['', '']],
  env1: [['アンプのエンベロープ', 'Amp envelope'], ['弾くたびに一度だけ動く（音量と同じ動き）', 'Runs once per note, like the loudness']],
  env2: [['エンベロープ 2', 'Envelope 2'], ['弾くたびに一度だけ動く', 'Runs once per note']],
  env3: [['エンベロープ 3', 'Envelope 3'], ['弾くたびに一度だけ動く', 'Runs once per note']],
  env4: [['エンベロープ 4', 'Envelope 4'], ['弾くたびに一度だけ動く', 'Runs once per note']],
  lfo1: [['LFO 1', 'LFO 1'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo2: [['LFO 2', 'LFO 2'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo3: [['LFO 3', 'LFO 3'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo4: [['LFO 4', 'LFO 4'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo5: [['LFO 5', 'LFO 5'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo6: [['LFO 6', 'LFO 6'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo7: [['LFO 7', 'LFO 7'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo8: [['LFO 8', 'LFO 8'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo9: [['LFO 9', 'LFO 9'], ['くり返し揺らす', 'Wobbles over and over']],
  lfo10: [['LFO 10', 'LFO 10'], ['くり返し揺らす', 'Wobbles over and over']],
  velocity: [['弾く強さ', 'Velocity'], ['強く弾くほど大きく動く', 'Moves more the harder you play']],
  note: [['音の高さ', 'Note'], ['高い音を弾くほど大きく動く', 'Moves more for higher notes']],
  modWheel: [['MOD ホイール', 'Mod wheel'], ['MIDI キーボードのホイールで動かす', 'Moved by the wheel on a MIDI keyboard']],
  aftertouch: [['アフタータッチ', 'Aftertouch'], ['鍵盤を押し込む強さで動かす', 'Moved by pressing into a held key']],
  pitchBend: [['ピッチベンド', 'Pitch bend'], ['ピッチベンドで動かす', 'Moved by the pitch wheel']],
  macro1: [['マクロ 1', 'Macro 1'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro2: [['マクロ 2', 'Macro 2'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro3: [['マクロ 3', 'Macro 3'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro4: [['マクロ 4', 'Macro 4'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro5: [['マクロ 5', 'Macro 5'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro6: [['マクロ 6', 'Macro 6'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro7: [['マクロ 7', 'Macro 7'], ['自分で動かすスライダー', 'A slider you move yourself']],
  macro8: [['マクロ 8', 'Macro 8'], ['自分で動かすスライダー', 'A slider you move yourself']],
  random: [['ランダム', 'Random'], ['弾くたびに違う値になる', 'A new value for every note']],
};

// Friendlier names for some menu options; the rest are shown as they are.
const OPTION: Record<string, Pair> = {
  Off: ['オフ', 'Off'],
  SyncWin: ['Sync（窓あり）', 'Sync (windowed)'],
  SawUp: ['ノコギリ（上り）', 'Saw up'],
  SawDown: ['ノコギリ（下り）', 'Saw down'],
  Sine: ['サイン', 'Sine'],
  Triangle: ['三角', 'Triangle'],
  Square: ['矩形', 'Square'],
  Saw: ['ノコギリ', 'Saw'],
  Pulse: ['パルス', 'Pulse'],
  Round: ['丸い矩形', 'Round'],
  'S&H': ['ランダム（階段）', 'Random steps'],
  Smooth: ['ランダム（なめらか）', 'Smooth random'],
  Custom: ['描く', 'Draw'],
  Lorenz: ['カオス（ローレンツ）', 'Chaos (Lorenz)'],
  Rossler: ['カオス（レスラー）', 'Chaos (Rössler)'],
  '1x': ['ふつう（1x）', 'Normal (1x)'],
  '2x': ['高い（2x）', 'High (2x)'],
  '4x': ['最高（4x）', 'Best (4x)'],
  Trig: ['弾くたび最初から', 'Restart per note'],
  Env: ['一度だけ', 'Once'],
  Free: ['止めずに動かす', 'Free running'],
  Normal: ['ふつう', 'Normal'],
  Up: ['上へ', 'Up'],
  Down: ['下へ', 'Down'],
  UpDown: ['上下', 'Up & down'],
  Played: ['弾いた順', 'As played'],
  Random: ['ランダム', 'Random'],
  Chord: ['和音', 'Chord'],
  PingPong: ['左右に往復', 'Ping-pong'],
  Tap: ['左に 1 回、右にくり返し', 'One left, repeats right'],
  'User 1': ['自分のテーブル 1', 'My table 1'],
  'User 2': ['自分のテーブル 2', 'My table 2'],
  Copy: ['同じ音を 2 つに', 'Two copies'],
  Bands: ['低音と高音', 'Lows and highs'],
  MidSide: ['中央と左右', 'Centre and sides'],
  LeftRight: ['左と右', 'Left and right'],
  Series: ['直列', 'Series'],
  Parallel: ['並列', 'Parallel'],
  Filter1: ['フィルター 1', 'Filter 1'],
  Filter2: ['フィルター 2', 'Filter 2'],
  Both: ['両方', 'Both'],
  Pre: ['歪みの前', 'Before'],
  Post: ['歪みの後', 'After'],
};

/** The kind of effect a unit is a copy of, and which copy: "dist2" -> ["dist", "2"]. */
function fxCopy(id: string): [string, string] {
  const m = /^(.+?)([23])$/.exec(id);
  return m && FX[m[1]] ? [m[1], m[2]] : [id, ''];
}

function generic(key: string): string {
  const [node, ...rest] = key.split('.');
  return [fxCopy(node)[0], ...rest]
    .join('.')
    .replace(/^osc[ABC]\./, 'osc.')
    .replace(/^filter2\./, 'filter.')
    .replace(/^env\d+\./, 'env.')
    .replace(/^lfo\d+\./, 'lfo.')
    .replace(/^macro\d+$/, 'macro');
}

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('seosynth.lang');
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    /* storage may be unavailable */
  }
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** Values for the {placeholders} of a text. */
export type Vars = Record<string, string | number>;

export type I18n = ReturnType<typeof createI18n>;

export function createI18n(lang: Lang) {
  const li = lang === 'ja' ? 0 : 1;
  const fill = (text: string, vars?: Vars) => (vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : text);
  const moverKind = (id: string) => (/^lfo/.test(id) ? 'lfo' : /^env/.test(id) ? 'env' : /^macro/.test(id) ? 'macro' : 'play');
  const api = {
    lang,
    /** UI string by key. Falls back to the key itself so gaps are visible. */
    t(key: string, vars?: Vars): string {
      const e = UI[key];
      return e ? fill(e[li], vars) : key;
    },
    /** Name of a node on the signal path (including effects). */
    nodeName(id: string): string {
      const [kind, copy] = fxCopy(id);
      if (FX[kind]) return copy ? `${FX[kind][0][li]} ${copy}` : FX[kind][0][li];
      return NODE[id] ? NODE[id][0][li] : SOURCE[id] ? SOURCE[id][0][li] : id;
    },
    nodeRole(id: string): string {
      const [kind] = fxCopy(id);
      return NODE[id] ? NODE[id][1][li] : FX[kind] ? FX[kind][1][li] : '';
    },
    nodeAbout(id: string): string {
      const [kind] = fxCopy(id);
      return NODE[id] ? NODE[id][2][li] : FX[kind] ? `${FX[kind][1][li]}${lang === 'ja' ? '。' : '.'}` : '';
    },
    moverAbout: (id: string): string => MOVER_ABOUT[moverKind(id)][li],
    paramLabel(key: string): string {
      const e = PARAM[generic(key)];
      if (!e) return key;
      const m = /^macro(\d)$/.exec(key);
      return m ? `${e[0][li]} ${m[1]}` : e[0][li];
    },
    /** A few plain words to go with the technical label, if any. */
    paramSub: (key: string): string => (PLAIN[generic(key)] ? PLAIN[generic(key)][li] : ''),
    paramHelp(key: string): string {
      const e = PARAM[generic(key)];
      if (e && e[1][li]) return e[1][li];
      // Effect switches share the effect's own description.
      const fx = FX[fxCopy(key.split('.')[0])[0]];
      return fx && key.endsWith('.on') ? fx[1][li] : '';
    },
    /** A slider's name with its node, e.g. "フィルターのカットオフ". */
    paramTitle(key: string): string {
      const label = api.paramLabel(key);
      if (/^macro\d+$/.test(key)) return label;
      const [mod] = key.split('.');
      const node = mod === 'master' ? '' : mod === 'env1' ? api.nodeName('amp') : api.nodeName(mod);
      if (!node || node === mod) return label;
      // "オシレーター A の…": a space after a name that ends in a letter or digit.
      const gap = /[A-Za-z0-9]$/.test(node) ? ' ' : '';
      return lang === 'ja' ? `${node}${gap}の${label}` : `${node} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    },
    sourceName: (key: string): string => (SOURCE[key] ? SOURCE[key][0][li] : key),
    sourceHelp: (key: string): string => (SOURCE[key] ? SOURCE[key][1][li] : ''),
    option: (name: string): string => (OPTION[name] ? OPTION[name][li] : name),
  };
  return api;
}

/** Exposed for tests: every parameter must have a label. */
export function hasParamText(key: string): boolean {
  return !!PARAM[generic(key)];
}
