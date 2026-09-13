(() => {
  const examples = JSON.parse(document.getElementById("examples").textContent);
  const tabs = [...document.querySelectorAll("[data-example]")];
  const versions = [...document.querySelectorAll("button[data-version]")];
  const timers = new WeakMap();
  let selected = examples[0];
  let version = "before";

  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tokens =
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\b(?:import|from|export|default|const|function|return|string)\b|\b\d+(?:\.\d+)?\b/g;

  function highlight(text) {
    let position = 0;
    let html = "";
    for (const match of text.matchAll(tokens)) {
      const value = match[0];
      const kind = value.startsWith("//")
        ? "code-comment"
        : /^["'`]/.test(value)
          ? "token-string"
          : /^\d/.test(value)
            ? "token-number"
            : "token-keyword";
      html += escape(text.slice(position, match.index));
      html += `<span class="${kind}">${escape(value)}</span>`;
      position = match.index + value.length;
    }
    return html + escape(text.slice(position));
  }

  function render() {
    const state = selected[version];
    const violation = state.violations[0];
    const source =
      selected.view === "files"
        ? Object.keys(state.files)
            .map((path) => path.slice(selected.path.length))
            .join("\n")
        : state.files[selected.path];

    tabs.forEach((tab) => {
      const active = tab.dataset.example === selected.id;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    versions.forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.version === version)),
    );
    document.getElementById("example-panel").setAttribute("aria-labelledby", `tab-${selected.id}`);
    document.getElementById("example-title").textContent = selected.title;
    document.getElementById("rule-code").innerHTML = highlight(selected.config);
    document.getElementById("source-path").textContent = selected.path;
    document.getElementById("source-code").innerHTML = source
      .split("\n")
      .map((line, index) =>
        index + 1 === state.highlight ? `<mark>${highlight(line)}</mark>` : highlight(line),
      )
      .join("\n");
    document.getElementById("source-view").dataset.version = version;
    document.getElementById("example-description").textContent = state.description;

    document.getElementById("result").dataset.passing = String(state.score >= 10);
    document.getElementById("result-symbol").textContent = state.score >= 10 ? "✓" : "×";
    document.getElementById("result-verdict").textContent = state.score >= 10 ? "Pass" : "Fail";
    document.getElementById("result-message").textContent =
      violation?.message ?? "No violations in this example.";
    document.getElementById("result-location").textContent = violation
      ? `${violation.path}${violation.line ? `:${violation.line}` : ""} · ${selected.ruleId}`
      : `0 violations · ${selected.ruleId}`;
    document.getElementById("result-score").textContent = state.score.toFixed(1);
    document.getElementById("result-category").textContent = `${selected.category} · ${
      violation ? `1 ${violation.severity === "warn" ? "warning" : violation.severity}` : "clear"
    }`;
    document.querySelectorAll(".code").forEach((pre) => {
      pre.scrollLeft = 0;
    });
    const copy = document.querySelector('[data-copy="rule-code"]');
    clearTimeout(timers.get(copy));
    delete copy.dataset.state;
    copy.querySelector("[data-label]").textContent = "Copy";
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      selected = examples.find((example) => example.id === tab.dataset.example);
      version = "before";
      render();
    });
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].focus({ preventScroll: true });
      tabs[next].click();
    });
  });

  versions.forEach((button) =>
    button.addEventListener("click", () => {
      version = button.dataset.version;
      render();
    }),
  );

  document.querySelectorAll("[data-copy]").forEach((button) => {
    const label = button.querySelector("[data-label]");
    label.setAttribute("aria-live", "polite");
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy);
      const value = target.textContent.trim();
      const feedback = document.getElementById("copy-feedback");
      clearTimeout(timers.get(button));
      feedback.textContent = "";
      button.disabled = true;
      button.dataset.state = "loading";
      label.textContent = "Copying";
      try {
        await navigator.clipboard.writeText(value);
        if (target.textContent.trim() === value) {
          button.dataset.state = "success";
          label.textContent = "Copied";
        }
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
        button.dataset.state = "error";
        label.textContent = "Select";
        feedback.textContent =
          "Clipboard access is unavailable. The text is selected for manual copying.";
      } finally {
        button.disabled = false;
        timers.set(
          button,
          setTimeout(() => {
            delete button.dataset.state;
            label.textContent = "Copy";
          }, 2200),
        );
      }
    });
  });

  render();
  document.querySelectorAll("[data-enhance]").forEach((element) => {
    element.hidden = false;
  });
})();
