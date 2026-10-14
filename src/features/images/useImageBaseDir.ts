import { useState, useEffect } from "react";
import { getImagesBaseDir } from "./api";

export function useImageBaseDir(): string | null {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    getImagesBaseDir()
      .then(setDir)
      .catch(() => {});
  }, []);
  return dir;
}
