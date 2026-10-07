import { alpha, createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#365CCF", dark: "#2846A6", light: "#E9EEFF" },
    success: { main: "#16845B" },
    warning: { main: "#C4740A" },
    error: { main: "#C83F49" },
    background: { default: "#F4F6FA", paper: "#FFFFFF" },
    text: { primary: "#172033", secondary: "#647087" },
    divider: "#E2E6EF",
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Inter", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    h4: { fontWeight: 720, fontSize: "1.45rem" },
    h5: { fontWeight: 720, fontSize: "1.2rem" },
    h6: { fontWeight: 700, fontSize: "1rem" },
    body2: { fontSize: "0.82rem" },
    button: { textTransform: "none", fontWeight: 650, fontSize: "0.82rem" },
  },
  components: {
    // Require a deliberate hover, including when moving between nearby controls.
    MuiTooltip: { defaultProps: { enterDelay: 450, enterNextDelay: 450 } },
    // Keep auxiliary controls quiet; main EEPROM actions and file selection opt into ripple.
    MuiButtonBase: { defaultProps: { disableRipple: true }, styleOverrides: { root: { "&.Mui-focusVisible": { outline: "2px solid #365CCF", outlineOffset: 2 } } } },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { minHeight: 32, padding: "4px 10px", borderRadius: 6 } } },
    MuiCard: { styleOverrides: { root: { border: "1px solid #E2E6EF", boxShadow: "0 1px 5px rgba(23,32,51,.035)" } } },
    MuiCardContent: { styleOverrides: { root: { padding: 14, "&:last-child": { paddingBottom: 14 } } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTableCell: { styleOverrides: { root: { padding: "7px 10px", fontSize: "0.8rem" }, head: { color: "#647087", fontWeight: 700, background: "#F8F9FC" } } },
    MuiChip: { styleOverrides: { root: { height: 24, fontWeight: 650, fontSize: "0.75rem" } } },
    MuiTabs: { styleOverrides: { root: { minHeight: 36 }, flexContainer: { minHeight: 36 } } },
    MuiTab: { styleOverrides: { root: { minHeight: 36, padding: "6px 12px", fontSize: "0.8rem" } } },
    MuiAccordionSummary: { styleOverrides: { root: { minHeight: 42, "&.Mui-expanded": { minHeight: 42 } }, content: { margin: "8px 0", "&.Mui-expanded": { margin: "8px 0" } } } },
    MuiListItemButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          minHeight: 36,
          borderRadius: 6,
          "&.Mui-selected": { background: alpha(theme.palette.primary.main, 0.1), color: theme.palette.primary.main },
        }),
      },
    },
  },
});
