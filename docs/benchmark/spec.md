Нужно спроектировать и затем поэтапно реализовать в текущем проекте Arena новый режим — **Testing / Benchmark Mode** для систематического тестирования локальных LLM.

Сначала внимательно изучи существующий проект, его архитектуру, модели данных, API, UI, текущие режимы Arena, систему промптов, модели/профили моделей, способы запуска моделей, workspace/project infrastructure, сбор метрик, watchdog и хранение результатов.

Не начинай сразу крупную реализацию.

Сначала составь технический implementation plan с привязкой к существующей кодовой базе. После согласования этот же план должен использоваться для реализации системы по небольшим этапам.

---

# 1. Общая идея Benchmark Mode

Benchmark Mode предназначен не для обычного сравнения ответов, а для полноценного прогона одной модели по фиксированному набору разносторонних задач.

Сценарий:

1. Пользователь выбирает Test Suite.
2. Выбирает конкретный профиль модели.
3. Выбирается фиксированный benchmark execution environment.
4. Запускается Test Run.
5. Модель последовательно выполняет все задачи suite.
6. Каждая задача выполняется только один раз.
7. Arena собирает telemetry, validation и execution outcome.
8. После выполнения пользователь оценивает результат:

   * PASS
   * FAIL
9. Для FAIL сохраняется причина.
10. Некоторые технические failures определяются автоматически.
11. После выполнения suite появляется отдельная страница результатов.
12. Test Runs сохраняются и могут сравниваться между моделями, профилями и quant-вариантами.

Главная quality-метрика:

`solved / total`

Например:

`9 / 12 — 75%`

Не превращать её в непрозрачный composite score.

---

# 2. Существующие возможности Arena

В проекте уже есть:

* модели;
* несколько profiles одной модели;
* разные конфигурации одной модели;
* система prompts;
* у prompt есть:

  * name;
  * body;
  * краткое human-readable description, которое модель не видит;
  * tag (`game`, `create`, `debug` и т.п.);
* watchdog;
* часть telemetry;
* project/workspace execution;
* несколько способов запуска модели;
* presets получения результата;
* раздел Models.

Не создавай параллельные сущности, если существующую инфраструктуру можно расширить.

Сначала выясни точную реализацию каждого механизма.

---

# 3. Execution Harness

Arena поддерживает несколько способов выполнения.

## llama.cpp

Практически прямой вызов модели.

Хорошо подходит для raw completion/reasoning задач, но плохо подходит как основной coding-agent benchmark по проектам.

## PI

Минимальная agent-обвязка с небольшим набором tools.

Предполагаемый основной execution environment для canonical Coding Benchmark.

Модель должна получать только необходимые инструменты:

* чтение файлов;
* поиск по проекту;
* редактирование;
* shell;
* запуск тестов/validation.

Цель:

дать модели рабочие руки, но не дополнительный интеллект поверх неё.

## OMP

Более мощная agent-система с дополнительными tools, workflows и presets.

Результат такого тестирования характеризует уже связку:

`model + OMP + tools + preset`

а не только модель.

OMP может использоваться позже как отдельный Full Agent Benchmark, но его результаты нельзя напрямую смешивать с PI benchmark.

---

# 4. Canonical Coding Benchmark Environment

Для первой версии основным benchmark environment должен стать PI с фиксированным минимальным toolset.

Например концептуально:

```text
Harness:
PI

Environment:
PI Benchmark v1

Mode:
project/workspace

Tools:
read
search
edit
shell
validation
```

После анализа проекта используй реальные существующие abstractions и названия.

Не создавай второй механизм tools.

---

# 5. Execution Environment Snapshot

Каждый Test Run должен сохранять фактические условия выполнения.

Например:

```ts
type ExecutionEnvironmentSnapshot = {
  harness: 'llama.cpp' | 'pi' | 'omp'
  harnessVersion?: string

  environmentVersion?: string
  executionPreset?: string
  toolsProfile?: string

  tools?: Array<{
    name: string
    version?: string
  }>
}
```

Это концептуальный пример.

Адаптируй к существующим типам.

---

# 6. Совместимость результатов

Для strict comparison должны совпадать как минимум:

* Test Suite;
* Suite Version;
* Benchmark Environment Version;
* Harness;
* execution semantics.

Например корректное сравнение:

```text
Tiel IQ4
Coding General v1
PI Benchmark v1

vs

Ornith IQ4
Coding General v1
PI Benchmark v1
```

Прогоны PI и OMP могут храниться и сравниваться исследовательски, но UI должен явно показывать, что environment отличается.

---

# 7. Test Suite

Добавить понятие Test Suite.

Пример:

`Coding General v1.0`

Suite содержит фиксированный упорядоченный список benchmark-задач.

Нужно версионирование.

Если prompt, fixture, validation или другие существенные условия изменены, новый запуск не должен молча считаться эквивалентным старому.

Продумай:

* version;
* immutable revision;
* snapshot;
* hashes.

---

# 8. Benchmark Test

Benchmark Test может использовать существующий Prompt, но ему нужны дополнительные параметры.

Пример концептуально:

```ts
interface BenchmarkTest {
  id: string

  promptId: string

  category: TestCategory
  difficulty: TestDifficulty

  fixtureId?: string

  limits?: {
    maxDurationMs?: number
    maxGeneratedTokens?: number
  }

  validation?: BenchmarkValidation

  manualReviewRequired: boolean
}
```

Не копируй этот интерфейс буквально, если текущая архитектура предполагает другой вариант.

---

# 9. Категории

Предлагаемый набор:

* Debugging
* Bug Fixing
* Feature Implementation
* Refactoring
* Code Understanding
* Algorithm / Reasoning
* UI / Frontend
* State Management / Logic
* API Integration
* Testing
* Constraint Following
* Long Context

Архитектура должна позволять добавлять новые категории.

---

# 10. Difficulty

Минимально:

* Easy
* Medium
* Hard
* Expert

Difficulty пока используется только для аналитики.

Не использовать multiplier в Solve Rate.

---

# 11. Fixture / Starter Project — обязательная часть системы

Для coding benchmark необходимо добавить полноценное понятие **Fixture / Starter Project**.

Fixture — это подготовленный исходный проект или набор файлов, который модель получает в начале benchmark-задачи.

Пример:

```text
stale-search-results/
├── package.json
├── src/
│   ├── App.tsx
│   ├── Search.tsx
│   └── api.ts
├── tests/
└── ...
```

Fixture может содержать:

* намеренный баг;
* недостающую feature;
* плохую реализацию для refactoring;
* API;
* существующие тесты;
* конфигурацию проекта;
* UI, который можно запустить.

Модель не должна изменять оригинальный fixture.

---

# 12. Три состояния проекта

Архитектурно разделить:

```text
Fixture
↓
Run Workspace
↓
Result Snapshot
```

### Fixture

Immutable исходное состояние.

### Run Workspace

Отдельная копия fixture для конкретного Test Run Task.

Только здесь работает модель.

### Result Snapshot

Итоговое состояние после модели:

* изменённые файлы;
* diff;
* execution logs;
* validation;
* telemetry.

---

# 13. Clean Workspace

Каждая задача запускается с чистого независимого workspace:

```text
immutable fixture
↓
create temporary run workspace
↓
model execution
↓
validation
↓
capture diff/result
↓
archive required artifacts
↓
cleanup
```

Изменения Test #1 не должны влиять на Test #2.

Изучи существующую project/workspace инфраструктуру Arena и переиспользуй её.

---

# 14. Fixture Versioning

Fixture должен иметь immutable revision/version.

Например:

```text
stale-search-results
revision 1
```

или content hash:

```text
fixture hash:
7f03a912...
```

Изменение fixture после существующих benchmark runs не должно менять их историю.

Test Run должен сохранять конкретную revision/hash.

---

# 15. Возможность создавать Fixtures

Нужен удобный authoring workflow.

Пользователь должен иметь возможность добавлять новые starter projects с багами без ручного вмешательства в benchmark internals.

Рассмотри несколько источников fixture:

### Local project/directory

Добавление подготовленной директории.

### ZIP

Upload небольшого проекта архивом.

### Existing Arena project

Если Arena уже умеет создавать запускаемые проекты, желательно предусмотреть возможность:

`Save as benchmark fixture`

### Agent-created fixture

Очень важный сценарий:

пользователь позже должен иметь возможность попросить coding-agent с доступом к Arena repository:

> Создай ещё один benchmark fixture для проверки race condition / React state / Node API / etc.

Агент должен иметь понятную documented структуру, куда добавить:

* starter project;
* metadata;
* validation;
* hidden tests;
* описание;
* возможно manifest.

Не проектируй fixture format так, чтобы новый пример требовал сложных ручных изменений в нескольких несвязанных subsystem.

---

# 16. Fixture Authoring Contract

Создай простой, документированный контракт для новых benchmark fixtures.

Например концептуально:

```text
benchmark/
  fixtures/
    stale-search-results/
      fixture/
        package.json
        src/
        ...

      benchmark.json

      validation/
        hidden.test.ts
```

Это лишь пример.

Выбери структуру, которая соответствует существующему проекту.

Главное:

новый fixture должен быть достаточно просто добавить вручную или через coding agent.

Желательно, чтобы агент мог:

1. создать directory;
2. создать небольшой broken project;
3. описать metadata;
4. добавить validator;
5. запустить fixture verification;
6. зарегистрировать fixture;
7. не менять benchmark engine.

---

# 17. Fixture Manifest

Продумай declarative manifest.

Например:

```ts
type FixtureManifest = {
  id: string
  name: string
  description: string

  runCommand?: string
  installCommand?: string

  expectedBaseline?: {
    build?: ...
    validation?: ...
  }
}
```

Не обязательно JSON.

Если существующий проект использует TypeScript configs или DB — выбери более естественный вариант.

Главная цель — сделать добавление нового fixture простым и предсказуемым.

---

# 18. Original Preview

Пользователь должен иметь возможность увидеть fixture **до запуска модели**.

На странице benchmark test желательно иметь:

```text
Starter Project

[ Open files ]
[ Run original ]
```

Для UI/project fixture пользователь должен иметь возможность запустить исходный broken project и увидеть проблему самостоятельно.

Оригинальный fixture при этом не должен запускаться непосредственно из immutable source.

Создавай временный preview workspace:

```text
Fixture
↓
Preview Workspace
↓
Run
↓
Cleanup
```

---

# 19. Result Preview

После выполнения модели пользователь должен видеть:

```text
Original                  Model Result

[ Open original ]         [ Open result ]
[ Run original ]          [ Run result ]

             [ View Diff ]
```

Если существующая Arena уже умеет запускать generated projects одной кнопкой, переиспользуй этот механизм.

Это особенно важно для UI/game/project benchmark задач.

---

# 20. Git / Diff

Для coding fixtures желательно иметь надёжный baseline.

Если это соответствует архитектуре проекта, можно использовать Git как основу:

```text
fixture baseline
↓
run workspace
↓
model changes
↓
git diff
```

Нужно сохранять:

* changed files;
* added files;
* removed files;
* diff.

Если в Arena уже существует собственный snapshot/diff механизм, сначала оцени его и не добавляй Git только ради Git.

---

# 21. Fixture Verification

При создании fixture пользователь или агент должен иметь возможность проверить, что benchmark example корректно подготовлен.

Нужна команда/action примерно уровня:

`Verify fixture`

Она проверяет исходное состояние.

Например для bug fixture:

```text
Install                    PASS
Build                      PASS
Typecheck                  PASS
Regression validator       FAIL ✓
Application starts         PASS
```

`Regression validator FAIL ✓` означает:

ошибка действительно присутствует в исходном fixture.

Это очень важно.

Нельзя запускать benchmark, если исходный broken example уже случайно исправлен.

---

# 22. Public и Hidden Validation

Разделить validation на два уровня.

## Public validation

Находится внутри fixture и доступна модели.

Например:

```text
npm test
npm run typecheck
npm run build
```

## Hidden benchmark validation

Хранится вне workspace модели.

Модель не должна видеть hidden validator.

После завершения execution Arena запускает hidden validation против Result Workspace.

Это предотвращает ситуацию, когда модель читает benchmark assertions и пишет решение непосредственно под них.

---

# 23. Baseline Validation

Validator желательно запускать как минимум в двух состояниях.

### Original Fixture

Например:

```text
Regression test: FAIL
```

Это ожидаемый результат.

### Model Result

```text
Regression test: PASS
```

Только тогда bug считается технически исправленным.

При этом Human Review всё равно остаётся отдельным уровнем.

---

# 24. Automatic Validation + Human Review

Не смешивать.

### Automatic

Например:

```text
Hidden regression    PASS
npm test             PASS
typecheck            PASS
build                PASS
```

### Human

```text
PASS
FAIL
```

Успешные tests сами по себе не гарантируют PASS.

Модель могла:

* нарушить ограничения;
* захардкодить ответ;
* удалить функциональность;
* изменить публичный API;
* обойти проблему.

---

# 25. Удобный Review Screen

После выполнения task пользователь должен видеть примерно:

```text
Fix stale search results

Execution:
finished

Automatic validation
✓ hidden regression
✓ npm test
✓ typecheck
✓ build

Changed files
3

[ Run Original ]
[ Run Result ]
[ Diff ]
[ Logs ]
[ Metrics ]

Did the model solve the task?

[ PASS ] [ FAIL ]
```

При FAIL выбрать причину.

---

# 26. Test Outcome

Разделить verdict и failure reason.

Например:

```ts
type TestVerdict =
  | 'pass'
  | 'fail'

type TestOutcome =
  | 'passed'
  | 'wrong-solution'
  | 'incomplete'
  | 'tests-failed'
  | 'constraint-violation'
  | 'timeout'
  | 'watchdog-kill'
  | 'runtime-error'
  | 'agent-crash'
  | 'invalid-output'
  | 'other'
```

Конкретный набор определить после анализа текущей системы.

---

# 27. Одна попытка

Одна benchmark задача = одна попытка.

Если модель:

* ошиблась;
* не закончила;
* была остановлена watchdog;
* получила timeout;
* упала;
* нарушила условия;

результат фиксируется.

Retry не изменяет исходный benchmark result.

При необходимости можно потом открыть задачу отдельно вне benchmark для исследования.

---

# 28. Watchdog

Существующий watchdog оставить.

Не заменять его обычным timeout.

Watchdog отвечает за патологическое поведение вроде loops.

`watchdog-kill` должен стать отдельным termination outcome.

---

# 29. Time Limit

Добавить независимый max duration для task.

Например:

```text
10 min
```

Если время превышено:

```text
timeout
```

и FAIL без retry.

Продумать корректную отмену agent execution.

---

# 30. Model Snapshot

Test Run должен сохранять не только ссылку на Profile, но и фактические runtime параметры.

Например:

* model;
* profile;
* quant;
* context;
* temperature;
* seed;
* backend;
* backend version;
* relevant generation parameters.

Изменение profile позже не должно менять историю старого Test Run.

---

# 31. Telemetry

Для каждого task желательно сохранять:

* duration;
* prompt/input tokens;
* generated/output tokens;
* average tok/s;
* TTFT, если доступно;
* tool calls;
* shell calls;
* files read;
* files written/changed;
* validation duration;
* watchdog events;
* termination reason.

Если доступно:

* peak context usage;
* tokens after successful validation;
* tool calls after successful validation;
* time after successful validation;
* files changed after successful validation.

---

# 32. Overthinking

Не обязательно сразу создавать Overthinking Score.

Сначала собирать объективные данные.

Например:

```text
first successful validation
↓
+ 4m 12s execution
+ 11 tool calls
+ 4200 tokens
```

Это позволит позже сравнивать способность моделей вовремя останавливаться.

---

# 33. Aggregate Run Metrics

После завершения Test Run:

* solved / total;
* Solve Rate;
* total duration;
* failed count;
* total generated tokens;
* avg generated tokens/task;
* generated tokens/successful task;
* avg tok/s;
* median task duration;
* avg task duration;
* watchdog kills;
* timeouts;
* crashes;
* failure distribution;
* tool calls;
* average tool calls/task.

---

# 34. Solve Rate

Главная quality metric:

```text
10 / 12
83%
```

Не смешивать сразу с efficiency, reliability или speed.

---

# 35. Efficiency

Отдельные показатели:

* generated tokens / successful task;
* time / successful task;
* tool calls / successful task.

Это позволит сравнить стоимость получения результата.

---

# 36. Reliability

Отдельный показатель стабильности.

Reliability должен учитывать технические failures:

* watchdog;
* timeout;
* crash;
* invalid agent output;
* context overflow;
* backend failure;
* tool loop.

Предложи простую и прозрачную формулу.

Не смешивать с Solve Rate.

---

# 37. Run Results Page

Верх:

```text
Tiel-Coder-35B-A3B
IQ4_XS
Coding General v1
PI Benchmark v1

83%
10 / 12 solved

Total time        43m 18s
Average speed     78 tok/s
Generated         81k
Reliability       92%
Watchdog kills    1
Timeouts          0
```

Ниже performance по category и difficulty.

Далее failure distribution.

Далее таблица tasks:

```text
Test                    Result       Time      Tokens
Fix race condition      PASS         2:18      4.1k
React state bug         PASS         1:43      3.8k
Parser                  FAIL         6:12      9.7k
Async worker            WATCHDOG    10:00     16.2k
```

---

# 38. Detailed Task Result

Для каждого task:

* Prompt;
* human description;
* category;
* difficulty;
* Fixture revision;
* Original;
* Result;
* Diff;
* Logs / Trace;
* Public validation;
* Hidden validation;
* Metrics;
* Human Verdict;
* Failure Reason.

---

# 39. Compare Runs

Позволить сравнить несколько совместимых runs.

Например:

| Metric      | Tiel | Ornith |  LFM |
| ----------- | ---: | -----: | ---: |
| Solve       |  83% |    75% |  67% |
| Debugging   | 100% |    80% |  60% |
| Avg tok/s   |   81 |     64 |  123 |
| Tokens/task | 6.8k |   8.1k | 9.4k |
| Time/task   | 3:21 |   4:03 | 2:59 |
| Watchdogs   |    0 |      1 |    2 |

При несовместимых benchmark environments показать предупреждение.

---

# 40. Model Details

Рассмотреть переработку Models.

Сейчас раздел в основном management-oriented.

Возможный вариант:

```text
/models
/models/:modelId
```

Model Details:

* model info;
* profiles;
* config;
* benchmark history;
* best/latest runs;
* category performance;
* reliability;
* efficiency;
* speed;
* generated tokens.

Management функционал сохранить.

---

# 41. Benchmark History

Нужен список Test Runs с фильтрами:

* model;
* profile;
* suite;
* version;
* environment;
* date;
* result.

Можно выбрать несколько совместимых runs и Compare.

---

# 42. Execution Flow

Предпочтительно:

```text
Select Suite
↓
Select Model Profile
↓
Review benchmark environment
↓
Start
↓
execute Test 1
↓
validate
↓
save
↓
execute Test 2
↓
...
↓
suite execution finished
↓
awaiting review
↓
user reviews tasks
↓
completed
↓
results
```

Manual review желательно делать после всего execution, чтобы пользователь не блокировал многочасовой run.

Проверь, насколько это соответствует текущей Arena architecture.

---

# 43. Lifecycle

Продумай state machine.

Например Run:

```text
created
running
awaiting-review
completed
aborted
```

Task:

```text
pending
running
finished
awaiting-review
reviewed
```

Не обязательно использовать именно эти enum.

Важно избежать невозможных состояний.

---

# 44. Recovery

Продумать:

* закрытие браузера;
* frontend restart;
* backend restart;
* backend crash;
* model backend unavailable;
* user abort.

Завершённые tasks нельзя терять.

Нельзя автоматически повторно запускать уже выполненную benchmark задачу.

Если run нельзя безопасно продолжить — сохранить как partial/aborted.

---

# 45. Примеры будущих Fixtures / Prompts

Система должна позволять легко создавать такие примеры.

## Fix stale search results

Небольшой React/TypeScript project.

Проблема:

старый async search response перезаписывает новый.

Hidden validation должен менять порядок завершения requests и проверять, что UI показывает данные последнего query.

Проверяет:

* async reasoning;
* debugging;
* минимальный fix;
* constraints.

## Inventory duplication

Небольшое приложение с багом дублирования items при определённой последовательности действий.

Hidden validation воспроизводит edge case.

## Undo / Redo

Рабочее приложение без undo/redo.

Модель должна добавить feature, сохранив существующее API.

## Parser Refactoring

Рабочий parser с плохой структурой.

Модель должна улучшить реализацию без изменения behavior.

## Stale state

Несколько React modules с неправильно выбранным источником состояния.

Проверяет code understanding.

## Dependency resolver

Небольшая algorithmic implementation с hidden edge cases.

## Constraint fixing

Bug fixture с жёсткими ограничениями:

* не менять API;
* не добавлять dependency;
* не менять tests;
* не переписывать module целиком.

## Regression Tests

Есть bug description и implementation.

Модель должна написать regression tests.

## Cross-module bug

Небольшой multi-module project, где причина бага распределена по нескольким файлам.

Проверяет long-context project navigation.

Полные prompts сейчас писать не нужно.

---

# 46. Возможность генерации новых Fixtures агентом

Это отдельное важное требование.

После реализации Benchmark Mode пользователь должен иметь возможность дать coding-agent задачу примерно:

> Добавь новый benchmark fixture категории Debugging. Сделай небольшой React-проект с конкретным воспроизводимым багом, hidden validation, baseline verification и зарегистрируй его в Coding General suite.

Архитектура и repository structure должны позволять агенту выполнить это без изменения benchmark engine.

Для этого подготовить developer documentation:

```text
How to add benchmark fixture
```

В ней описать:

1. где находятся fixtures;
2. требования к размеру и структуре;
3. как объявить metadata;
4. как добавить Prompt;
5. как создать public validation;
6. как создать hidden validation;
7. как определить expected broken baseline;
8. как запустить fixture verification;
9. как добавить test в suite;
10. как проверить, что модель hidden tests не видит.

---

# 47. Fixture Quality Requirements

Каждый новый bug fixture должен удовлетворять требованиям:

* проблема реально воспроизводится;
* проект запускается;
* unrelated functionality работает;
* fixture достаточно маленький для benchmark;
* причина бага не должна быть обозначена очевидным `TODO`;
* не должно быть искусственных бессмысленных ошибок;
* должен существовать корректный и достаточно локальный fix;
* hidden validator должен отличать настоящий fix от поверхностного workaround;
* original fixture должен стабильно FAIL нужный regression validation;
* reference fixed version желательно PASS;
* модель не должна видеть hidden validation.

---

# 48. Reference Solution

Рассмотри возможность опционально хранить **reference solution** для fixture.

Но модель никогда не должна иметь к нему доступ во время benchmark.

Reference solution может использоваться разработчиком для:

* проверки fixture;
* проверки validator;
* документации;
* regression проверки benchmark infrastructure.

Не использовать reference implementation для автоматического сравнения исходного кода один-в-один.

Валидных решений может быть несколько.

---

# 49. MVP

Для первой рабочей версии достаточно:

* Suite + version;
* Benchmark Test;
* Prompt integration;
* Fixture;
* Fixture verification;
* temporary clean workspace;
* PI Benchmark environment;
* sequential execution;
* watchdog;
* timeout;
* public validation;
* hidden validation;
* diff;
* PASS / FAIL;
* failure reason;
* basic telemetry;
* Results;
* History.

Не блокировать MVP из-за:

* radar charts;
* сложного Reliability Score;
* сложного Overthinking Score;
* leaderboard;
* OMP benchmark;
* advanced fixture marketplace/editor.

Но data model должна позволять их добавить позже.

---

# 50. Что нужно сделать сначала

Сейчас не начинай реализовывать всю систему.

Сначала проведи архитектурный аудит.

Найди в проекте:

* Prompt;
* Models;
* Model Profiles;
* llama.cpp execution;
* PI execution;
* OMP execution;
* tools;
* presets;
* project generation;
* project preview/run;
* Arena runs;
* task execution;
* workspace management;
* file snapshots;
* diff;
* watchdog;
* telemetry;
* persistence;
* API;
* routing;
* UI components;
* existing history/results.

После аудита опиши только релевантную архитектуру.

---

# 51. Затем предложи итоговую архитектуру

Раздели на:

### Existing infrastructure to reuse

и

### New benchmark-specific infrastructure

Особенно внимательно рассмотри, как встроить Fixtures в существующие project/workspace механизмы.

---

# 52. Data Model

Предложи конкретную data model с привязкой к реальным технологиям проекта.

Нужны концепты уровня:

* TestSuite;
* SuiteRevision/Version;
* BenchmarkTest;
* Fixture;
* FixtureRevision;
* ValidationDefinition;
* TestRun;
* TestRunTask;
* ModelSnapshot;
* ExecutionEnvironmentSnapshot;
* ValidationResult;
* TaskMetrics;
* HumanReview;
* ResultSnapshot.

Не создавать отдельные таблицы для всего автоматически.

Выбери разумную нормализацию.

---

# 53. Fixture Storage

Отдельно проанализируй, как лучше хранить starter projects:

* repository directories;
* DB metadata + filesystem;
* archives;
* existing Arena project storage.

Учитывай:

* immutable revisions;
* clone speed;
* cleanup;
* diff;
* previews;
* hidden validators;
* возможность легко добавлять fixture через coding agent.

---

# 54. API / Backend

Спроектируй backend flow:

```text
start run
↓
select next test
↓
resolve fixture revision
↓
create clean workspace
↓
start PI execution
↓
watchdog/time limit
↓
finish model execution
↓
run validation
↓
capture telemetry
↓
capture diff/result snapshot
↓
persist
↓
next test
```

Используй существующий API style проекта.

---

# 55. UI / Routes

Продумай минимум:

* Benchmark / Test Suites;
* Suite Details;
* Test Details;
* Fixture Details;
* Fixture Preview;
* Create/Edit Test;
* Start Run;
* Active Run;
* Review;
* Run Result;
* Task Result;
* History;
* Compare;
* Model Details.

Не обязательно всё делать в MVP.

---

# 56. Implementation phases

После анализа разбей реализацию на маленькие фазы.

Предварительный вариант:

### Phase 1 — Benchmark domain/data model

Типы, persistence, migrations.

### Phase 2 — Fixtures foundation

Fixture storage, revisions, manifest, clean copies.

### Phase 3 — Fixture preview + verification

Open files, Run Original, Verify Fixture.

### Phase 4 — Test Suites/Test management

Prompt + Fixture + Validation + metadata.

### Phase 5 — Test Run execution

PI canonical environment, sequential tasks.

### Phase 6 — Watchdog + Time Limit

Termination outcomes.

### Phase 7 — Validation

Public + Hidden + baseline/result semantics.

### Phase 8 — Result Snapshot + Diff

Before/After, changed files, Run Result.

### Phase 9 — Telemetry

Task/run statistics.

### Phase 10 — Manual Review

PASS / FAIL + reasons.

### Phase 11 — Run Results

Solve rate + detailed dashboard.

### Phase 12 — History + Compare

Comparison between compatible runs.

### Phase 13 — Model Details

Benchmark analytics integrated into Models.

### Phase 14 — Reliability / Efficiency / Overthinking

Derived metrics.

### Phase 15 — Fixture Authoring UX/docs

Make adding new benchmark examples simple for humans and coding agents.

Correct this sequence if existing architecture suggests a better dependency order.

---

# 57. Требования к каждому Phase

Для каждого этапа укажи:

* цель;
* concrete changes;
* files/modules affected;
* data migrations;
* dependencies;
* risks;
* tests;
* manual verification;
* definition of done.

После implementation этапа:

1. typecheck;
2. relevant tests;
3. lint;
4. build, если оправдано;
5. manual check;
6. update implementation plan.

Не делать сразу огромный diff.

---

# 58. Общие правила

Следуй существующей архитектуре проекта.

Не создавай framework внутри framework.

Переиспользуй:

* model profiles;
* runners;
* project execution;
* preview;
* tool system;
* prompt system;
* watchdog;
* telemetry;
* API patterns;
* persistence;
* UI components.

Если existing subsystem нужно рефакторить, сначала объясни:

* почему;
* какой benchmark requirement без этого плохо реализуется;
* насколько изменение безопасно для обычной Arena.

---

# 59. Что нужно предоставить сейчас

На первом шаге не реализовывай весь Benchmark Mode.

Предоставь рабочий architecture/implementation plan:

1. релевантный аудит текущего проекта;
2. что можно переиспользовать;
3. что нужно добавить;
4. итоговую архитектуру;
5. data model;
6. Fixture architecture;
7. Fixture storage/versioning;
8. способ создания новых Fixtures;
9. public/hidden validation architecture;
10. Test Run lifecycle;
11. Test Task lifecycle;
12. execution pipeline;
13. timeout/watchdog integration;
14. telemetry;
15. API;
16. routes/UI;
17. model page changes;
18. implementation phases;
19. definition of done каждого этапа;
20. основные риски;
21. минимальный MVP.

Отдельно ответь на вопрос:

**Насколько текущая архитектура Arena уже позволяет реализовать workflow `broken fixture → model workspace → validation → before/after → human verdict`, и какие существующие механизмы можно использовать почти без изменений?**

Также предложи конкретный простой workflow, по которому в будущем другой coding-agent сможет добавить новый bug fixture в benchmark, не изучая весь Benchmark subsystem.

## Fixture Types

Fixture не обязательно содержит баг.

Benchmark fixture представляет **исходное состояние проекта перед выполнением задачи** и может соответствовать разным типам задания.

Минимально система должна поддерживать следующие сценарии:

### Bug Fix

Проект содержит воспроизводимый дефект.

До модели:

`regression validation = FAIL`

После правильного решения:

`regression validation = PASS`

---

### Feature Implementation

Проект полностью работоспособен, но в нём отсутствует требуемая возможность.

Например:

* Undo / Redo;
* pagination;
* keyboard navigation;
* caching;
* новый API endpoint.

До модели:

* существующие tests PASS;
* feature-specific hidden validation FAIL.

После модели:

* существующие tests продолжают PASS;
* feature-specific validation PASS.

---

### Refactoring

Проект уже работает корректно.

Модель должна изменить внутреннюю реализацию при сохранении поведения.

Validation должна проверять:

* существующие tests;
* публичный API;
* поведение;
* дополнительные structural constraints, если их возможно объективно проверить.

---

### Testing

Проект содержит реализацию, но не хватает regression/unit/integration tests.

Validation может проверять:

* появились необходимые тесты;
* тест действительно воспроизводит заданное поведение;
* исходная реализация с намеренно возвращённым дефектом приводит к падению нового теста;
* текущая корректная реализация проходит его.

---

### Algorithm / Implementation

Fixture может содержать интерфейс, skeleton или незавершённую функцию.

Модель должна реализовать заданное поведение.

Основная проверка выполняется hidden tests с edge cases.

---

### Code Understanding / Cross-module Task

Fixture представляет небольшой существующий проект.

Задача требует разобраться в нескольких модулях и сделать изменение в правильном месте.

Не обязательно, чтобы исходное состояние проекта было технически сломано.

---

### UI / Interactive Feature

Fixture представляет запускаемое приложение.

Validation может включать:

* unit/integration tests;
* browser/e2e checks;
* состояние UI;
* взаимодействия пользователя.

Пользователь должен иметь возможность сравнить `Run Original` и `Run Result`.

---

Fixture infrastructure не должна предполагать универсальное правило:

`original validation must fail`.

Вместо этого у fixture/test должна быть декларативная **expected baseline state**.

Например:

```ts
baseline: {
  build: 'pass',
  existingTests: 'pass',
  benchmarkValidation: 'fail'
}
```

Для другого типа задания:

```ts
baseline: {
  build: 'pass',
  existingTests: 'pass'
}
```

Конкретная модель должна соответствовать архитектуре проекта.

Главный принцип:

**Baseline Verification проверяет, что исходный fixture находится именно в том состоянии, которое требуется конкретному benchmark test.**

Это может быть как наличие бага, так и отсутствие feature, корректно работающий код перед refactoring или частично реализованный API.

Также developer documentation `How to add benchmark fixture` должна описывать создание fixtures разных типов, а не только bug fixtures.

