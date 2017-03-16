import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';

import isEqual from 'lodash/isEqual';
import flattenDeep from 'lodash/flattenDeep';

import { setAttribute } from './dom';

export const symbol = Symbol('__render');

function dh(ele: Node & { __subscriptions: Subscription[] }) {
  (ele.__subscriptions || []).forEach(sub => sub.unsubscribe());
  [...ele.childNodes].forEach(cn => dh(Object(cn)));
}

// TODO: 加入生命周期，如 onAttach onDetach: 只有 onDetach 方法可以实现，而 onAttach 无法实现，因为根本不知道什么时候才会被 attach 到 document 上，而 attach 到 parent 上没有意义。。。除非使用 Observable 监视 top parent 被 attach 到 document 上去的事件。
// TODO: 规范 attrs 的设置和更新

function h(tag: string, attrs: Object, ...children): Node & { __subscriptions: Subscription[] } {
  let __subscriptions: Subscription[] = [];
  let element = Object.assign(document.createElement(tag), { __subscriptions });
  let obs_anchor_elements: { observable: Observable<any>, anchor: Comment, elements: { node: Node, data: any }[] }[] = [];

  for (let key in attrs) {
    if (attrs.hasOwnProperty(key)) {
      let value = attrs[key];
      if (value instanceof Observable) {
        __subscriptions.push(value.subscribe(v => setAttribute(element, key, v)));
      } else {
        setAttribute(element, key, value);
      }
    }
  }
  children = flattenDeep(children);
  children.forEach(child => {
    if (child instanceof Node) {
      element.appendChild(child);
    } else if (child instanceof Observable) {
      let anchor = document.createComment('anchor');
      element.appendChild(anchor);
      obs_anchor_elements.push({ observable: child, anchor: anchor, elements: [] });

      let subscription = child.subscribe(value => {
        // 不提供 Observable<Array>，却仍让使用者使用整个列表来判断渲染什么的功能`list.length==0 ? <div>Not Found</div> : <ul>many lis</ul>`，因为这会让使用者滥用该功能，造成性能下降。
        // 应该让使用者 list$.map(list=>list.length==0).distinctUntilChanged().combineLatest(Observable.of(notfound=>notfound?<div>NotFound</div>:<ul>{list$.combineLatest(Observable.of(item=><li>{item.tostring()}</li>))}</ul>))
        // 如果使用者 list$.combineLatest(Observable.of(item=><ul>{item.tostring()}</ul>)) 则会生成多个 ul，在开发期就能知道错误
        // let [v, render] = value;
        // let { v, __rendernode, __renderlist } = value

        // let v, render = value[symbol];
        // if (render) {
        //   v = value.data;
        // }else {
        //   v = value;
        //   render = data => document.createTextNode(data+'');
        // }

        let v, render;
        if (typeof value==='string') {
          v = value;
          render = str => document.createTextNode(str);
        } else if (Object.prototype.toString.call(value)!='[object Array]' || value.length!=2 || typeof value[1]!='function') {
          v = value;
          // Observable 返回 null，但不自定义 render，则把它作为字符串显示
          render = str => document.createTextNode(str+'');
        } else {
          [v, render] = value;
        }

        // 这里不做非空过滤，保留使用者对空值的处理能力
        let vs = [].concat(v);//.filter(v => v);
        let oae = obs_anchor_elements.find(oae => oae.observable==child);
        let anchor = oae.anchor;
        let old_elements = oae.elements.slice();
        let old_display = element.style.display;
        if (vs.length>0) {
          oae.elements = vs.map(vi => {
            // 使用 key 加快比较速度
            let found = old_elements.find(o => isEqual(vi['key'], o.data['key']) && isEqual(vi, o.data));
            if (found) {
              old_elements.splice(old_elements.indexOf(found), 1);
              return { node: found.node, data: vi };
            }
            // 这里 render(vi) 可能得到的是空值 null/undefined，或者非 Node 元素
            return { node: render(vi), data: vi };
          });
          // TODO: 也许可以使用 DocumentFragment 来减少重绘。或者把 element 隐藏修改再显示
          // 因为 oae.elements 里可能有非 Node 元素，避免 insertBefore 出错，所以要在这里进行过滤
          element.style.display = 'none';
          oae.elements.slice().filter(ele => ele.node instanceof Node).forEach(ele => element.insertBefore(ele.node, anchor));
        } else {
          oae.elements = [];
        }
        element.style.display = 'none';
        // 因为 oae.elements 里可能有非 Node 元素，避免 remove 出错，所以要在这里进行过滤
        old_elements.filter(oe => oe.node instanceof Node).forEach(oe => {
          let node = Object(oe.node);
          dh(node);
          // remove 函数不要放进 dh 中，因为 dh 要每个元素都 dh，但 remove 只要顶级元素 remove 就好
          node.remove();
        });
        element.style.display = old_display;
      });

      __subscriptions.push(subscription);
    } else if (child!=null || child!=undefined) {
      element.appendChild(document.createTextNode(child+''));
    } else {
      throw new Error('Not Support Child Type!');
    }
  });
  return element;
}

// TODO: 提供 debug 机制，让错误更清楚，知道是在该库之外的哪里使用错误
// h['debug'] = false;

export default h;

// 简单的 data$.combineLatest(Observable.of(render), (data, render)=>({data, [symbol]: render}))
// 手动 combine 能做到动态修改 render 方法。。。那也不一定是 Observable.of，可以是别的创建 Observable 的方法
export function hr(data$: Observable<any>, render: (any) => Node & { __subscriptions: Subscription[] }) {
  return data$.map(data => ({data: data, [symbol]: render}));
}

// <div>
//     {hnode(tocs$.map(tocs=>tocs.length>0).distinctUntilChanged(), gt0 => gt0 ? (
//       <ul>{hlist(tocs$, toc => <li data-title={toc.title}>1</li>)}</ul>
//     ) : (<div>jiangui</div>))}
// </div>

// // 下面这种语法会造成 Observable<Observable> 虽然可以用 flatMap，但是因为 tocs$ 是不会 complete 的，所以只能递归 append 到 parent 上，还有其他各种问题，禁止
// <div>
//     {hnode(tocs$.map(tocs=>tocs.length>0).distinctUntilChanged(), gt0 => gt0 ? (
//       hnode(tocs$, tocs=><ul>{tocs.map(toc=><li data-title={toc.title}>1</li>)}</ul>)
//     ) : (<div>jiangui</div>))}
// </div>