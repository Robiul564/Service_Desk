import { ApiError } from "../api.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["title", "description", "category"];

// Same rules as the backend schema, so people get feedback before the round trip.
const RULES = {
  title: (v) => (v.length < 3 ? "Give the request a title of at least 3 characters." : v.length > 120 ? "Keep the title under 120 characters." : ""),
  description: (v) => (v.length < 10 ? "Describe what needs to be done in at least 10 characters." : v.length > 2000 ? "Keep the description under 2000 characters." : ""),
  category: (v) => (v ? "" : "Choose a category."),
};

function showError(name, message) {
  const input = $(`r-${name}`);
  $(`r-${name}-err`).textContent = message;
  input.setAttribute("aria-invalid", message ? "true" : "false");
}

function validateField(name) {
  const message = RULES[name]($(`r-${name}`).value.trim());
  showError(name, message);
  return !message;
}

function setFormError(message) {
  const box = $("form-error");
  box.textContent = message ?? "";
  box.hidden = !message;
}

export function initRequestForm({ onSubmit }) {
  const dialog = $("form-dialog");
  const form = $("request-form");
  let editingId = null;

  FIELDS.forEach((name) => {
    $(`r-${name}`).addEventListener("blur", () => validateField(name));
    $(`r-${name}`).addEventListener("input", () => {
      if ($(`r-${name}`).getAttribute("aria-invalid") === "true") validateField(name);
    });
  });
  $("r-description").addEventListener("input", (e) => {
    $("r-count").textContent = `${e.target.value.length} / 2000`;
  });
  $("form-cancel").addEventListener("click", () => dialog.close());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFormError(null);
    const valid = FIELDS.map(validateField).every(Boolean);
    if (!valid) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }

    const payload = {
      title: $("r-title").value.trim(),
      description: $("r-description").value.trim(),
      category: $("r-category").value,
      priority: $("r-priority").value,
    };

    const submit = $("form-submit");
    submit.disabled = true;
    try {
      await onSubmit(payload, editingId);
      dialog.close();
    } catch (err) {
      if (err instanceof ApiError && err.details.length) {
        err.details.forEach((d) => FIELDS.includes(d.field) && showError(d.field, d.message));
      }
      setFormError(err.message);
    } finally {
      submit.disabled = false;
    }
  });

  return {
    open(existing = null) {
      editingId = existing?.id ?? null;
      form.reset();
      FIELDS.forEach((name) => showError(name, ""));
      setFormError(null);
      $("form-title").textContent = existing ? `Edit ${existing.reference}` : "New request";
      $("form-submit").textContent = existing ? "Save changes" : "Submit request";
      if (existing) {
        $("r-title").value = existing.title;
        $("r-description").value = existing.description;
        $("r-category").value = existing.category;
        $("r-priority").value = existing.priority;
      }
      $("r-count").textContent = `${$("r-description").value.length} / 2000`;
      dialog.showModal();
      $("r-title").focus();
    },
  };
}
