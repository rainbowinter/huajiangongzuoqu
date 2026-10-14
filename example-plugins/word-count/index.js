floral.register({
  name: "word-count",
  onLoad(api) {
    api.registerStatusBarItem((selection) => {
      if (!selection || !selection.text) return null;
      const chars = Array.from(selection.text.replace(/\s/g, "")).length;
      return `选中 ${chars} 字`;
    });
  },
});
