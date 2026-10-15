# orc-kit

Плагин Claude Code для лида-оркестратора, который делегирует работу субагентам и herdr-сессиям. Даёт 8 ролей, 3 skills (`orc`, `brief`, `handoff`), хуки (защита от повторных чтений и тяжёлых проверок у агентов), скрипты (статус-строка с контекстом, `ctx`, сторож транскриптов) и шаблоны. Всё, что зависит от проекта, лежит в одном файле `<проект>/.claude/orc-kit.json`. Скрипты - обычный Node (CommonJS, без зависимостей), работают на Windows и Linux.

## Состав
- `agents/`: `implementer`, `reviewer`, `reviewer-critical`, `integrator`, `release`, `scout`, `consult`, `media` (имена в сессии: `orc-kit:<роль>`).
- `skills/`: `orc` (правила лида), `brief` (шаблоны брифов), `handoff` (передача смены).
- `hooks/hooks.json`: `read-guard` (Read), `heavy-check-guard` (Bash), `session-start`.
- `scripts/`: `statusline.cjs`, `ctx.cjs`, `watchdog.cjs`, хуки, `lib/`.
- `templates/`: `orc-kit.json`, `CLAUDE-section.md`, `STATE.md`, `HANDOFF.md`.

## Установка
```
claude plugin marketplace add D:\Projects\orc-kit
claude plugin install orc-kit@orc-kit-local --scope project
```
`--scope project` пишет включение в `.claude/settings.json` проекта; по умолчанию scope `user` (во всех проектах). Для отладки без установки: `claude --plugin-dir D:\Projects\orc-kit` (грузится на месте, правки подхватываются при новом старте или `/reload-plugins`). Проверка: `claude plugin validate D:\Projects\orc-kit`.

Затем в проекте:
1. Скопируй `templates/orc-kit.json` в `<проект>/.claude/orc-kit.json` и заполни.
2. Вставь `templates/CLAUDE-section.md` в `CLAUDE.md` проекта и подставь команды.
3. Положи `templates/STATE.md` туда, где проект хранит состояние (путь - `handoff.statePath`).

## Что плагин сделать не может (вручную)
- **statusLine.** Плагин не ставит `statusLine` (в настройках плагина действуют только `agent` и `subagentStatusLine`). Добавь в `~/.claude/settings.json` или `.claude/settings.json` проекта:
  ```json
  "statusLine": { "type": "command", "command": "node \"D:/Projects/orc-kit/scripts/statusline.cjs\"", "refreshInterval": 30 }
  ```
  (ссылка на `${CLAUDE_PLUGIN_ROOT}` в `statusLine.command` документацией не подтверждена, поэтому путь абсолютный.) Статус-строка пишет `<cwd>/.claude/ctx-<session_id>.json`; добавь `.claude/ctx-*.json` в `.gitignore`.
- **Глобальные модель и усилие.** Лид запускается явно: `claude --model opus --effort medium`. Глобальные `model` и `effortLevel` в `~/.claude/settings.json` меняет владелец. Переменная `CLAUDE_CODE_EFFORT_LEVEL` не должна быть задана (перебивает frontmatter ролей и `effort` вызова).
- **TTL кэша.** `subagentPromptCacheTtl: "1h"` (и `promptCacheTtl` при оплате по API) ставит владелец после выбора типа оплаты.
- **Метка лида.** Для `heavyGuard.requireLeadEnv` лид запускается с переменной окружения `ORC_ROLE=lead`.
- **poppler.** Роли `media` нужны `pdftotext` и `pdftoppm`.

## Файл конфигурации `.claude/orc-kit.json`
Недостающие ключи берутся из `templates/orc-kit.json`; объекты сливаются рекурсивно, массивы заменяются. Поля `_comment*` игнорируются. Нет файла - хуки ничего не запрещают, кроме правил `readGuard`.

| Ключ | По умолчанию | Смысл |
|---|---|---|
| `checks.fast` | `""` | команда быстрых проверок проекта; агенты запускают только её |
| `checks.full` | `""` | полная проверка; только лид, один раз на итоговом дереве, в фоне |
| `heavyCommands` | `[]` | регэкспы (строки) тяжёлых команд; субагенту они запрещены |
| `readGuard.maxRepeat` | `3` | сколько подряд чтений одного пути разрешено (4-е запрещено) без Edit/Write/Bash между ними |
| `readGuard.maxImageBytes` | `2097152` | предел размера картинки для чтения |
| `readGuard.leadNoMedia` | `true` | лид (вызов без `agent_id`) не читает PDF и картинки, это делает роль `media` |
| `heavyGuard.requireLeadEnv` | `false` | `true`: тяжёлые команды и у лида разрешены только при `ORC_ROLE=lead` |
| `thresholds.ctxPrepare` | `120000` | токенов контекста лида: обновить STATE |
| `thresholds.ctxHandoff` | `150000` | токенов: новый пакет не брать, передача смены |
| `lead.model` / `lead.effort` | `opus` / `medium` | с какими параметрами стартует кандидат в `/handoff` |
| `handoff.allowSendKeysExit` | `false` | разрешение владельца: новый лид шлёт `/exit` в старую вкладку через `herdr agent send-keys` |
| `handoff.candidatePermissionArgs` | `[]` | аргументы режима прав кандидата, например `["--permission-mode","acceptEdits"]` |
| `handoff.statePath` / `handoffPath` | `STATE.md` / `HANDOFF.md` | где лежат состояние и файл передачи |
| `criticalPaths` | `[]` | критичные области проекта: правки там идут на `reviewer-critical` |

Пример (проект на npm): `{"checks":{"fast":"npm run wf:check -- --profile fast","full":"npm run wf:check -- --profile full"},"heavyCommands":["\\bnpm\\s+run\\s+test:e2e\\b","\\bnpm\\s+test\\s*$"],"criticalPaths":["src/billing/**"]}`.

## Хуки
- `read-guard` отклоняет Read: тот же путь `maxRepeat` раз подряд (по ключу сессия+агент, сброс после Edit/Write/Bash); PDF без `pages`; картинку больше `maxImageBytes`; любой PDF и картинку у лида при `leadNoMedia`.
- `heavy-check-guard` отклоняет команды из `heavyCommands`, если вызывает субагент (в stdin есть `agent_id`).
- `session-start` печатает версию, путь найденного конфига и напоминание загрузить skill `orc`.
- Любой сбой хука (битый JSON, нет прав на tmp) - разрешение. Состояние хранится в `<tmp>/orc-kit/<session_id>/`.

## Сторож транскриптов
`node scripts/watchdog.cjs [--interval 30] [--once] [--notify "<команда>"]`: предупреждает о росте файла `~/.claude/projects/**/*.jsonl` больше 10 МиБ/мин два интервала подряд, размере выше 100 МиБ и выше 250 МиБ при продолжающемся росте. Никого не останавливает. Жёсткие остановки: `read-guard` и `maxTurns` ролей.

## Правила в одну страницу
1. Лид - Opus/medium, модель и усилие задаются при запуске явно (`--model opus --effort medium`); глобальный fallback роль не заменяет.
2. Исполнитель - Sonnet/medium; деньги, восстановление, миграции - Sonnet/high.
3. Обычное ревью и проверка правок обычного пакета - Sonnet/medium; критичное ревью - Opus/high в 1-м круге; на критичном пакете итоговый вердикт и проверка денежных находок - Opus/high, Sonnet проверяет только некритичные находки.
4. Opus повторно - если правка меняет денежный инвариант.
5. Haiku/low - только механика с машинно проверяемым результатом; не браузер, не разведка.
6. Fable - арбитр спорного вопроса или консультация; не лид и не ревью по умолчанию.
7. Мелочь - ≤2 команды, вывод ≤100 строк (~3K токенов), без правок кода пакетов - лид делает сам; больше - в файл или агенту.
8. При каждом вызове Agent лид передаёт `effort` явно.
9. Лид не читает PDF и изображения, транскрипты, логи и файлы >100 строк целиком; вложения - файлом с путём роли `media`.
10. Лид не пишет код пакетов, не гоняет проверки синхронно, не опрашивает агентов.
11. Контекст лид читает из `.claude/ctx-<session>.json` (`ctx.cjs`) на границе этапа: 120K - обновить STATE; 150K - новый пакет не брать, передача смены; ~170K - передача на ближайшей границе этапа.
12. Большой вывод не втягивать; если втянут - `/rewind` делает владелец. `/clear` у лида не применяется.
13. В чат ≤25 строк; отчёт агента ≤25 строк (ревью ≤30); крупное - в файл.
14. Бриф одной тегированной структуры; обычный ≤500 слов, критичное ревью ≤800; бриф >200 строк - ошибка постановки.
15. Проверки - только через проектный раннер; голый тест-раннер и `full` у агентов запрещены.
16. `full` - один на итоговом дереве, только лид, в фоне, после fast; incomplete - сначала причина, перезапуск только упавшей фазы.
17. Лимит ревью - 3 круга; второй `CHANGES_REQUIRED` - лид меняет постановку, а не шлёт того же исполнителя.
18. Суб-лида нет; по умолчанию прямые Agent; herdr-воркер - когда нужен свой процесс или интерактив владельца.
19. Лимит: лид + 2 рабочих суммарно; одна тяжёлая проверка на машину.
20. «Существенное» для консультации - по 5 признакам (деньги/данные, контракт/миграция, труднообратимая зависимость, конфликт ключевых требований, два неудачных подхода); обычный формат - ответ + критик, один раунд.

## Тесты
```
cd D:\Projects\orc-kit
node --test
```
Команда `node --test` без аргументов находит `tests/*.test.cjs` на Node 20 и 24 (форма `node --test tests/` на Node 24 не работает: каталог воспринимается как модуль). Зависимостей нет.

## Проверено
- `node --test` (Node 24.18): tests 27, pass 27, fail 0 (read-guard, heavy-check-guard, statusline, ctx, config, session-start, watchdog, --help).
- `claude plugin validate D:/Projects/orc-kit`: Validation passed (marketplace); `.../.claude-plugin/plugin.json`: Validation passed.
