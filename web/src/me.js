import { createContext, useContext } from 'react';

export const MeContext = createContext(null);
export const useMe = () => useContext(MeContext);
