// Simple client-side gate, the same as the calculator's: it hides the page, it does not protect it.
const ACCESS_PASSWORD = "danilo123";
const ACCESS_SESSION_KEY = "conversor3mf_authenticated";

const loginGate = document.getElementById("loginGate");
const appContent = document.getElementById("appContent");
const loginForm = document.getElementById("loginForm");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");
const togglePassword = document.getElementById("togglePassword");
const lockButton = document.getElementById("lockButton");

function unlockApp() {
  sessionStorage.setItem(ACCESS_SESSION_KEY, "1");
  loginGate.hidden = true;
  appContent.classList.remove("app-locked");
  appContent.setAttribute("aria-hidden", "false");
  document.body.classList.remove("login-open");
}

function lockApp() {
  sessionStorage.removeItem(ACCESS_SESSION_KEY);
  loginPassword.value = "";
  loginPassword.type = "password";
  togglePassword.textContent = "Mostrar";
  loginError.hidden = true;
  loginGate.hidden = false;
  appContent.classList.add("app-locked");
  appContent.setAttribute("aria-hidden", "true");
  document.body.classList.add("login-open");

  window.setTimeout(() => loginPassword.focus(), 50);
}

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (loginPassword.value === ACCESS_PASSWORD) {
    unlockApp();
    return;
  }

  loginError.hidden = false;
  loginPassword.select();
});

loginPassword.addEventListener("input", () => {
  loginError.hidden = true;
});

togglePassword.addEventListener("click", () => {
  const isPassword = loginPassword.type === "password";
  loginPassword.type = isPassword ? "text" : "password";
  togglePassword.textContent = isPassword ? "Ocultar" : "Mostrar";
  togglePassword.setAttribute("aria-label", isPassword ? "Ocultar senha" : "Mostrar senha");
});

lockButton.addEventListener("click", lockApp);

if (sessionStorage.getItem(ACCESS_SESSION_KEY) === "1") {
  unlockApp();
} else {
  document.body.classList.add("login-open");
  window.setTimeout(() => loginPassword.focus(), 50);
}
