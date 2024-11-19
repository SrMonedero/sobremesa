import lume from "lume/mod.ts";
import tailwind from "lume/plugins/tailwindcss.ts";
import postcss from "lume/plugins/postcss.ts";

const site = lume();

site.use(tailwind());
site.use(postcss());

export default site;
