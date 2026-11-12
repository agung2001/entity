/* Applies the saved theme before the module graph paints anything. */
try {
  if (localStorage.getItem('entity.theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.colorScheme = 'dark'
  }
} catch {
  /* storage unavailable: the light default is already in the CSS */
}
