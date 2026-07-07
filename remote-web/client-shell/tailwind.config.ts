import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          fox: "#FF5020",
          foxHover: "#E94316",
          foxSoft: "#FFF2EC",
          navy: "#002050",
          navy2: "#073B7A",
          ink: "#101828",
          muted: "#667085",
          bg: "#F6F8FC",
          line: "#E6EBF3"
        },
        shell: {
          bg: "#f6f8fc",
          line: "#e6ebf3",
          text: "#101828",
          muted: "#667085",
          blue: "#073b7a",
          strong: "#002050"
        }
      },
      boxShadow: {
        dock: "0 14px 24px rgba(255, 80, 32, 0.18)"
      }
    }
  },
  plugins: []
} satisfies Config;
