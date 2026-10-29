import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n-browser";
import { Search } from "lucide-react";

export interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	width?: number;
}

/** Text filter with a leading search glyph. */
export function SearchInput({ value, onChange, placeholder = __ompTranslate("Filter…"), width }: SearchInputProps) {
	return (
		<label className="search">
			<Search size={14} />
			<input
				className="input"
				type="search"
				value={value}
				placeholder={placeholder}
				onChange={e => onChange(e.target.value)}
				style={width !== undefined ? { width } : undefined}
			/>
		</label>
	);
}
