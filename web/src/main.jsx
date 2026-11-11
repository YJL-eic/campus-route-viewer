import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return createElement("pre", null, String(this.state.error.stack || this.state.error));
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  createElement(Boundary, null, createElement(App))
);
