import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ContactChips } from "../ContactChips";

describe("ContactChips", () => {
  it("renders phone chip when phone is present", () => {
    render(<ContactChips phone="+79161112233" email={null} clientName="Клиент" outstanding={50000} />);
    const link = screen.getByRole("link", { name: /позвонить/i });
    expect(link).toHaveAttribute("href", "tel:+79161112233");
  });

  it("renders email chip when email is present", () => {
    render(<ContactChips phone={null} email="client@example.com" clientName="Клиент" outstanding={50000} />);
    const link = screen.getByRole("link", { name: /написать/i });
    expect(link.getAttribute("href")).toMatch(/^mailto:client@example\.com/);
  });

  it("prefills email body with outstanding amount mention", () => {
    render(<ContactChips phone={null} email="client@example.com" clientName="Ромашка" outstanding={142000} />);
    const link = screen.getByRole("link", { name: /написать/i });
    const href = link.getAttribute("href") ?? "";
    // href should contain the Russian reminder text
    expect(href).toContain("body=");
    expect(href).toContain("142");
  });

  it("renders nothing when both phone and email are absent", () => {
    const { container } = render(<ContactChips phone={null} email={null} clientName="Клиент" outstanding={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders both chips when both phone and email are present", () => {
    render(<ContactChips phone="+7999" email="a@b.com" clientName="Клиент" outstanding={1000} />);
    expect(screen.getByRole("link", { name: /позвонить/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /написать/i })).toBeInTheDocument();
  });
});
