const themeToggle = document.querySelector("#theme-toggle");

if (themeToggle) {
  const isDark = window.localStorage.getItem("lsm-tree-theme") === "dark";
  document.body.classList.toggle("dark-theme", isDark);
  themeToggle.setAttribute("aria-label", isDark ? "Enable light theme" : "Enable dark theme");
  themeToggle.querySelector("span").textContent = "◐";

  themeToggle.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark-theme");
    window.localStorage.setItem("lsm-tree-theme", dark ? "dark" : "light");
    themeToggle.setAttribute("aria-label", dark ? "Enable light theme" : "Enable dark theme");
    document.querySelector('meta[name="theme-color"]').content = dark ? "#202a25" : "#f3f1e9";
  });
}
