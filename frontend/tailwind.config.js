import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{html,tsx,ts}"],
  theme: {
    extend: {}
  },
  plugins: [typography]
};
