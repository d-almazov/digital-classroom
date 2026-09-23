(() => {
  "use strict";

  const EXECUTION_TIMEOUT = 8000;
  const INITIALIZATION_TIMEOUT = 45000;

  class RuntimeError extends Error {}
  class TimeoutError extends Error {}

  class PyodideRuntime {
    constructor(workerUrl) {
      this.workerUrl = workerUrl;
      this.worker = null;
      this.readyPromise = null;
      this.pending = new Map();
      this.requestId = 0;
      this.queue = Promise.resolve();
    }

    setStatus(message, state = "idle") {
      document.querySelectorAll("[data-runtime-status]").forEach((element) => {
        element.textContent = message;
        element.dataset.state = state;
      });
    }

    ensureReady() {
      if (this.readyPromise) {
        return this.readyPromise;
      }

      this.setStatus("Python завантажується…", "loading");
      this.worker = new Worker(this.workerUrl);

      this.readyPromise = new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new RuntimeError("Не вдалося завантажити Python вчасно."));
          this.destroyWorker();
        }, INITIALIZATION_TIMEOUT);

        const handleMessage = (event) => {
          const message = event.data;

          if (message.type === "ready") {
            window.clearTimeout(timer);
            this.setStatus("Python готовий", "ready");
            resolve();
            return;
          }

          if (message.type === "init-error") {
            window.clearTimeout(timer);
            reject(new RuntimeError("Не вдалося завантажити Python. Перевірте з’єднання з інтернетом і спробуйте ще раз."));
            this.destroyWorker();
            return;
          }

          if (message.type === "result") {
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            window.clearTimeout(request.timer);
            request.resolve(message);
          }
        };

        this.worker.addEventListener("message", handleMessage);
        this.worker.addEventListener("error", () => {
          window.clearTimeout(timer);
          reject(new RuntimeError("Python не вдалося запустити у браузері."));
          this.rejectPending(new RuntimeError("Середовище Python несподівано зупинилося."));
          this.destroyWorker();
        }, { once: true });

        this.worker.postMessage({ type: "init" });
      });

      this.readyPromise.catch(() => {
        this.setStatus("Python недоступний", "error");
      });

      return this.readyPromise;
    }

    run(code) {
      const operation = this.queue
        .catch(() => undefined)
        .then(() => this.execute(code));
      this.queue = operation;
      return operation;
    }

    async execute(code) {
      await this.ensureReady();
      const id = ++this.requestId;

      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(id);
          this.destroyWorker();
          this.setStatus("Python буде перезапущено під час наступного запуску", "error");
          reject(new TimeoutError("Виконання тривало надто довго й було зупинено. Перевірте цикли у своєму коді."));
        }, EXECUTION_TIMEOUT);

        this.pending.set(id, { resolve, reject, timer });
        this.worker.postMessage({ type: "run", id, code });
      });
    }

    rejectPending(error) {
      this.pending.forEach((request) => {
        window.clearTimeout(request.timer);
        request.reject(error);
      });
      this.pending.clear();
    }

    destroyWorker() {
      if (this.worker) {
        this.worker.terminate();
      }
      this.worker = null;
      this.readyPromise = null;
    }
  }

  class PythonExercise {
    constructor(root, runtime) {
      this.root = root;
      this.runtime = runtime;
      this.editor = root.querySelector("[data-code-editor]");
      this.output = root.querySelector("[data-output]");
      this.feedback = root.querySelector("[data-feedback]");
      this.runButton = root.querySelector('[data-action="run"]');
      this.checkButton = root.querySelector('[data-action="check"]');
      this.resetButton = root.querySelector('[data-action="reset"]');
      this.starterCode = this.readJson("[data-starter-code]");
      this.expectedOutput = this.readJson("[data-expected-output]");

      this.runButton.addEventListener("click", () => this.run(false));
      this.checkButton.addEventListener("click", () => this.run(true));
      this.resetButton.addEventListener("click", () => this.reset());
      this.editor.addEventListener("keydown", (event) => this.handleEditorKeydown(event));
    }

    readJson(selector) {
      return JSON.parse(this.root.querySelector(selector).textContent);
    }

    handleEditorKeydown(event) {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const start = this.editor.selectionStart;
      const end = this.editor.selectionEnd;
      this.editor.setRangeText("    ", start, end, "end");
    }

    setBusy(isBusy) {
      this.runButton.disabled = isBusy;
      this.checkButton.disabled = isBusy;
      this.resetButton.disabled = isBusy;
      this.root.dataset.busy = String(isBusy);
    }

    async run(shouldCheck) {
      this.setBusy(true);
      this.feedback.replaceChildren();
      this.output.textContent = "Виконання…";

      try {
        const result = await this.runtime.run(this.editor.value);

        if (!result.ok) {
          this.output.textContent = `Помилка виконання:\n\n${result.error}`;
          this.showFeedback(
            "error",
            "Код завершився з помилкою.",
            "Прочитайте повідомлення вище, виправте код і спробуйте ще раз."
          );
          return;
        }

        const standardOutput = result.stdout || "Програма не вивела текст.";
        this.output.textContent = result.stderr
          ? `${standardOutput}\n\nПовідомлення stderr:\n${result.stderr}`
          : standardOutput;
        if (shouldCheck) {
          this.checkResult(result.stdout);
        }
      } catch (error) {
        const message = error instanceof TimeoutError || error instanceof RuntimeError
          ? error.message
          : "Не вдалося виконати код. Спробуйте ще раз.";
        this.output.textContent = `Виконання зупинено:\n\n${message}`;
        this.showFeedback("error", "Не вдалося виконати програму.", message);
      } finally {
        this.setBusy(false);
      }
    }

    checkResult(stdout) {
      const actual = this.normalizeOutput(stdout);
      const expected = this.normalizeOutput(this.expectedOutput);

      if (actual === expected) {
        this.showFeedback(
          "success",
          "✓ Правильно!",
          "Чудова робота. Результат відповідає очікуваному."
        );
        return;
      }

      this.showFeedback(
        "error",
        "✗ Результат відрізняється від очікуваного.",
        "Спробуйте ще раз.",
        { actual, expected }
      );
    }

    normalizeOutput(value) {
      return String(value).replace(/\r\n?/g, "\n").trim();
    }

    showFeedback(state, title, message, comparison) {
      const heading = document.createElement("strong");
      const description = document.createElement("p");
      heading.textContent = title;
      description.textContent = message;
      this.feedback.dataset.state = state;
      this.feedback.append(heading, description);

      if (!comparison) return;

      const comparisonGrid = document.createElement("div");
      comparisonGrid.className = "python-exercise__comparison";
      comparisonGrid.append(
        this.createComparison("Ваш результат", comparison.actual || "Немає виводу"),
        this.createComparison("Очікуваний результат", comparison.expected || "Немає виводу")
      );
      this.feedback.append(comparisonGrid);
    }

    createComparison(label, value) {
      const wrapper = document.createElement("div");
      const heading = document.createElement("span");
      const output = document.createElement("pre");
      heading.textContent = label;
      output.textContent = value;
      wrapper.append(heading, output);
      return wrapper;
    }

    reset() {
      this.editor.value = this.starterCode;
      this.output.textContent = "Код ще не запускався.";
      this.feedback.replaceChildren();
      delete this.feedback.dataset.state;
      this.root.querySelectorAll("details[open]").forEach((details) => {
        details.open = false;
      });
      this.editor.focus();
    }
  }

  const exercises = [...document.querySelectorAll("[data-python-exercise]")];
  if (!exercises.length) return;

  const runtime = new PyodideRuntime(exercises[0].dataset.workerUrl);
  exercises.forEach((exercise) => new PythonExercise(exercise, runtime));
})();
