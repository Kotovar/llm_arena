# Исходные промпты бенчмарка

Черновики заданий первой версии suite, как их написал автор. Это ещё не fixtures и не
задачи в базе: здесь формулировка, требования, замысел скрытой проверки и соображения о
том, что каждое задание измеряет.

Порядок реализации и разбиение на fixtures — в [плане](../../BENCHMARK-PLAN.md), фаза 9.

| # | Название | Сложность | Тип задачи |
| --- | --- | --- | --- |
| [01](01.md) | Fix stale search results | Medium | Debugging / async / race condition |
| [02](02.md) | Implement undo and redo history | Medium | Feature / state management |
| [03](03.md) | Refactor order pricing without changing behavior | Medium | Refactoring |
| [04](04.md) | Add regression tests for cart rules | Medium | Testing |
| [05](05.md) | Implement paginated user loading | Medium | Feature / API integration |
| [06](06.md) | Fix incorrect permission propagation | Hard | Code understanding / cross-module |
| [07](07.md) | Implement dependency resolution order | Medium | Algorithm / reasoning |
| [08](08.md) | Build a mini Kanban board | Hard | Создание с нуля / React |
| [09](09.md) | Build a room booking API | Hard | Создание с нуля / Node.js / concurrency |
| [10](10.md) | Build a streaming log analyzer CLI | Hard | Создание с нуля / CLI / данные |
| [11](11.md) | Build a transactional wallet service | Hard | Создание с нуля / БД / транзакции |
| [12](12.md) | Implement a debounce utility | не указана | Algorithm / кандидат на overthinking |
| [13](13.md) | Add filtering to a task list | не указана | Feature / кандидат на overthinking |
| [14](14.md) | Build a persistent job queue with retries | Very Hard | Создание с нуля / состояние / recovery |
| [15](15.md) | Build a virtualized spreadsheet editor | Very Hard | Создание с нуля / UI / производительность |
| [16](16.md) | Build a turn-based tactics game | Hard | Создание с нуля / игровая логика |

Сложность — как она указана в самом задании. У 12 и 13 её нет: по тексту обе маленькие и
задуманы как материал для будущей метрики overthinking.

[coverage.md](coverage.md) — авторская сводка покрытия по первым одиннадцати.
