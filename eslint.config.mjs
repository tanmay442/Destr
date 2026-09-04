import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tailwindcss from "eslint-plugin-tailwindcss";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["packages/domain/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Domain code must not read process.env; inject configuration from infrastructure.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/marketing/Ferrofluid.tsx"],
    plugins: { tailwindcss },
    settings: {
      tailwindcss: {
        cssConfigPath: "src/app/globals.css",
      },
    },
    rules: {
      "no-console": "error",
      "tailwindcss/classnames-order": "error",
      "tailwindcss/no-contradicting-classname": "error",
    },
  },
]);

export default eslintConfig;
