import { useCallback, useEffect, useState } from "react";
import { errorText } from "./format";

export function useLoad<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    let gone = false;
    load().then(
      (v) => {
        if (gone) return;
        setValue(v);
        setError(undefined);
      },
      (e) => !gone && setError(errorText(e)),
    );
    return () => {
      gone = true;
    };
  }, [load]);
  useEffect(reload, [reload]);
  return { value, error, reload };
}
