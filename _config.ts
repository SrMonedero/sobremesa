import lume from "lume/mod.ts";
import postcss from "lume/plugins/postcss.ts";
import googleFonts from "lume/plugins/google_fonts.ts";
import tailwindcss from "lume/plugins/tailwindcss.ts";

const site = lume();

site.use(googleFonts({
    fonts: "https://fonts.googleapis.com/css2?family=Cherry+Bomb+One&family=Inter:wght@100..900&family=Pacifico&display=swap",
}));

site.use(tailwindcss({
  // Extract the classes from HTML and JSX files
  extensions: [".html", ".jsx"],

  // Your Tailwind options, like the theme colors and fonts
  options: {
    theme: {
      fontFamily: {
        serif: ["Cherry Bomb One", "serif"],
        sans: ["Inter", "sans-serif"],
      },
    },
  },
}));

site.use(postcss());

export default site;
