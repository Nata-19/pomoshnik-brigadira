// Минимальный тест: грузим Whisper-tiny и распознаём короткий синтетический сигнал.
// Цель — убедиться, что пакет вообще работает на этой машине / на Render.
(async () => {
  console.time('Загрузка модели');
  const { pipeline } = await import('@huggingface/transformers');
  const t = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
  console.timeEnd('Загрузка модели');

  // Сделаем тишину 1 секунду 16 кГц моно — модель должна вернуть пустоту,
  // но это проверит сам пайплайн вывода.
  const samples = new Float32Array(16000); // одна секунда тишины

  console.time('Распознавание тишины');
  const result = await t(samples, { language: 'russian', task: 'transcribe' });
  console.timeEnd('Распознавание тишины');
  console.log('Результат:', JSON.stringify(result));

  console.log('\n✅ Whisper работает. Можно деплоить.');
})().catch(e => {
  console.error('❌ Whisper упал:', e.message);
  console.error(e.stack);
  process.exit(1);
});
