/** Рисует JUnit-отчёт `node --test`: файл → группы → тесты, у упавших — сообщение. */
function renderCase(testcase) {
  const item = document.createElement("li");
  const failure = testcase.querySelector(":scope > failure");
  item.className = failure ? "fail" : "pass";
  item.textContent = `${failure ? "✗" : "✓"} ${testcase.getAttribute("name")}`;
  if (failure) {
    const message = document.createElement("pre");
    message.textContent = failure.getAttribute("message") ?? failure.textContent;
    item.append(message);
  }
  return item;
}

function renderNode(node) {
  if (node.tagName === "testcase") return renderCase(node);
  const item = document.createElement("li");
  item.className = "suite";
  item.textContent = node.getAttribute("name");
  const list = document.createElement("ul");
  list.append(...[...node.children].filter((child) => child.tagName === "testcase" || child.tagName === "testsuite").map(renderNode));
  item.append(list);
  return item;
}

const xml = new DOMParser().parseFromString(await (await fetch("tests.xml")).text(), "application/xml");
const top = [...xml.documentElement.children].filter((child) => child.tagName === "testcase" || child.tagName === "testsuite");
/** Группируем по файлу: у набора его нет, берём у первого теста внутри. */
const fileOf = (node) => node.getAttribute("file") ?? node.querySelector("testcase")?.getAttribute("file") ?? "?";
const files = Map.groupBy(top, fileOf);
const report = document.getElementById("report");
for (const [file, nodes] of files) {
  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = file;
  const list = document.createElement("ul");
  list.append(...nodes.map(renderNode));
  section.append(title, list);
  report.append(section);
}
const cases = xml.querySelectorAll("testcase");
const failed = xml.querySelectorAll("testcase > failure").length;
document.getElementById("summary").textContent = cases.length
  ? `Тестов: ${cases.length}, файлов: ${files.size}, упало: ${failed}`
  : "Тестов не найдено";
