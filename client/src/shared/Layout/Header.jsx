export default function Header({ onMenuToggle }) {
  return (
    <header className="header">
      <button className="header-menu-btn" onClick={onMenuToggle} aria-label="Menu">☰</button>
      <div className="header-logo">
        <div className="header-logo-mark">F</div>
        <span className="header-logo-text">OS<span>FPM</span></span>
      </div>
    </header>
  )
}
